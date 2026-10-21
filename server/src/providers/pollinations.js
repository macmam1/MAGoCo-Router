// Pollinations - keyless, OpenAI compatible, no registration.
//
// Nothing to configure: no key, no session, no fingerprint. The only thing the
// provider needs is a model id from its public catalogue.
export const pollinations = {
  id: "pollinations",
  baseUrl: "https://gen.pollinations.ai/v1",
  modelsUrl: "https://gen.pollinations.ai/v1/models",
};

export function buildHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
}
