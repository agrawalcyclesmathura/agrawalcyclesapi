import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { App, cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

export interface FirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export interface AdminApproval {
  approved: boolean;
  role?: string;
}

/**
 * Thin wrapper around the Firebase Admin SDK. Verifies Firebase ID tokens so the
 * backend can establish identity WITHOUT ever trusting a flag sent by the client.
 *
 * Three configurations, resolved at boot:
 *  - Emulator: `FIREBASE_AUTH_EMULATOR_HOST` set → init with projectId only
 *    (the Admin SDK talks to the local Auth emulator; no real credentials needed).
 *  - Production: `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`
 *    (service-account cert credentials).
 *  - Unconfigured: the app still boots (customer auth is unaffected); any admin
 *    Firebase verification returns 503 with an actionable message.
 */
@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private app: App | null = null;

  constructor() {
    this.app = this.init();
  }

  private init(): App | null {
    if (getApps().length) return getApps()[0];

    const projectId = process.env.FIREBASE_PROJECT_ID;
    const emulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;

    if (emulator) {
      if (!projectId) {
        this.logger.warn("FIREBASE_AUTH_EMULATOR_HOST set but FIREBASE_PROJECT_ID missing — Firebase disabled.");
        return null;
      }
      this.logger.log(`Firebase Admin using Auth emulator at ${emulator} (project ${projectId}).`);
      return initializeApp({ projectId });
    }

    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    // Support both real newlines and the escaped `\n` form common in env files.
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

    if (projectId && clientEmail && privateKey) {
      this.logger.log(`Firebase Admin initialised for project ${projectId} (service-account credentials).`);
      return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    }

    // Verification-only mode: a projectId alone is enough to verify ID token
    // signatures (Google's public certs are fetched over HTTP, no secret key
    // needed). Sufficient here since we only verify identity, never perform
    // privileged Admin operations. Add a service account for extra hardening.
    if (projectId) {
      this.logger.log(
        `Firebase Admin initialised for project ${projectId} (ID-token verification only; ` +
          "no service-account key — set FIREBASE_CLIENT_EMAIL/PRIVATE_KEY to add one).",
      );
      return initializeApp({ projectId });
    }

    this.logger.warn(
      "Firebase is not configured (set FIREBASE_PROJECT_ID, optionally + FIREBASE_CLIENT_EMAIL/PRIVATE_KEY, " +
        "or FIREBASE_AUTH_EMULATOR_HOST for local dev). Admin sign-in will be unavailable until configured.",
    );
    return null;
  }

  get isConfigured() {
    return this.app !== null;
  }

  /** Verify a Firebase ID token and return the identity, or throw 401/503. */
  async verifyIdToken(idToken: string): Promise<FirebaseIdentity> {
    if (!this.app) {
      throw new ServiceUnavailableException("Firebase authentication is not configured on the server.");
    }
    if (!idToken || typeof idToken !== "string") {
      throw new UnauthorizedException("Missing Firebase ID token.");
    }
    let decoded;
    try {
      // No checkRevoked: revocation is enforced by our own admin status/refresh
      // revocation, and checkRevoked would require a service-account credential.
      decoded = await getAuth(this.app).verifyIdToken(idToken);
    } catch {
      throw new UnauthorizedException("Invalid or expired Firebase ID token.");
    }
    if (!decoded.email) {
      throw new UnauthorizedException("Firebase account has no email address.");
    }
    return {
      uid: decoded.uid,
      email: decoded.email.toLowerCase(),
      emailVerified: Boolean(decoded.email_verified),
      name: (decoded.name as string | undefined) ?? undefined,
    };
  }

  /**
   * Read the admin-approval record from the Firestore `admins` collection, using
   * the SIGNED-IN USER'S OWN ID token (no service-account key). It looks the user
   * up by BOTH their UID and their email as the document id (whichever you used),
   * and accepts `approved` / `admin` / `isAdmin` as either a boolean `true` or the
   * string "true". An optional `role` string selects the RBAC role.
   *
   * Returns the record, or `null` when no matching approved doc is found (missing
   * doc, rules-denied read, or flag not truthy). Never throws — authorization is
   * best-effort here; the owner-controlled ADMIN_EMAILS allowlist is the
   * guaranteed path (see AuthService).
   */
  async getAdminApproval(idToken: string, uid: string, email?: string): Promise<AdminApproval | null> {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) return null;
    const collection = process.env.FIREBASE_ADMIN_COLLECTION ?? "admins";
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    const base = emulator ? `http://${emulator}` : "https://firestore.googleapis.com";

    type Field = { booleanValue?: boolean; stringValue?: string };
    const truthy = (f?: Field) =>
      !!f && (f.booleanValue === true || (typeof f.stringValue === "string" && f.stringValue.trim().toLowerCase() === "true"));

    const readDoc = async (docId: string): Promise<Record<string, Field> | null> => {
      const url = `${base}/v1/projects/${projectId}/databases/(default)/documents/${collection}/${encodeURIComponent(docId)}`;
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${idToken}` },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null; // 404 (no doc) / 403 (rules) / other → not found
        const doc = (await res.json().catch(() => null)) as { fields?: Record<string, Field> } | null;
        return doc?.fields ?? {};
      } catch {
        return null; // network/timeout → treat as not found (fail closed)
      }
    };

    // Try UID first, then email, so a doc keyed either way is honoured.
    for (const docId of [uid, email].filter((v): v is string => !!v)) {
      const fields = await readDoc(docId);
      if (!fields) continue;
      if (truthy(fields.approved) || truthy(fields.admin) || truthy(fields.isAdmin)) {
        return { approved: true, role: fields.role?.stringValue };
      }
    }
    return null;
  }
}
