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
   * Read the admin-approval record for a Firebase UID from the Firestore `admins`
   * collection, using the SIGNED-IN USER'S OWN ID token (not a service-account
   * key). Firestore security rules let each user read only their own `admins/{uid}`
   * doc and DENY all writes — so the flag can only be set by an admin in the
   * Firebase console, never forged by the client.
   *
   * A doc grants access when `approved` (or `admin`) is boolean true; an optional
   * `role` string selects the RBAC role. Returns null when the UID has no doc.
   * Throws 503 on a Firestore outage/misconfig (fails closed — no session).
   */
  async getAdminApproval(idToken: string, uid: string): Promise<AdminApproval | null> {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      throw new ServiceUnavailableException("FIREBASE_PROJECT_ID is not set — admin authorization unavailable.");
    }
    const collection = process.env.FIREBASE_ADMIN_COLLECTION ?? "admins";
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    const base = emulator ? `http://${emulator}` : "https://firestore.googleapis.com";
    const docPath = `projects/${projectId}/databases/(default)/documents/${collection}/${encodeURIComponent(uid)}`;
    const url = `${base}/v1/${docPath}`;

    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
    } catch {
      throw new ServiceUnavailableException("Could not reach the admin authorization store (Firestore).");
    }

    // 404 = no doc for this UID; 403 = rules denied → treat both as "not listed".
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `Admin authorization store returned ${res.status}. Check that Firestore is enabled and its rules allow a signed-in user to read their own "${collection}/{uid}" doc.`,
      );
    }

    const doc = (await res.json().catch(() => null)) as { fields?: Record<string, { booleanValue?: boolean; stringValue?: string }> } | null;
    const fields = doc?.fields ?? {};
    return {
      // Accept either `approved` or `admin` as the boolean flag.
      approved: fields.approved?.booleanValue === true || fields.admin?.booleanValue === true,
      role: fields.role?.stringValue,
    };
  }
}
