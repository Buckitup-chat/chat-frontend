import { ml_dsa87 } from "@noble/post-quantum/ml-dsa.js";
import { transport } from "@/lib/data/transport";

// Requests go through the protocol library's transport (src/lib/data/transport.ts).

export const api = {
  ingestWithAuthEach: (mutations, signSkey) =>
    transport.ingestEachResponse(mutations, (message) => ml_dsa87.sign(message, signSkey)),

  getDeviceIdentity: () => transport.deviceIdentity(),

  getChallenge: () => transport.challenge(),
};
