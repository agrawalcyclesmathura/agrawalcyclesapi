import { Global, Module } from "@nestjs/common";
import { FirebaseService } from "./firebase.service";

/** Global so any module can verify Firebase ID tokens without re-importing. */
@Global()
@Module({
  providers: [FirebaseService],
  exports: [FirebaseService],
})
export class FirebaseModule {}
