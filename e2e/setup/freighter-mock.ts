/**
 * freighter-mock.ts
 *
 * This inject script mocks the `@stellar/freighter-api` interface on
 * the `window.freighter` object and basic Albedo intent intercepts. 
 * Allows deterministic E2E resting without requiring the Freighter extension
 * to be installed in the Playwright browser.
 */

const freighterMock = `
  window.freighter = {
    isConnected: async () => true,
    isAllowed: async () => true,
    setAllowed: async () => true,
    getUserInfo: async () => ({
      publicKey: "GAJRNUO6HSMQG4FNHNWQVRXJZJZ7QRA7HXPYYB6H5PTA3EAAJXJNZD7U"
    }),
    getPublicKey: async () => "GAJRNUO6HSMQG4FNHNWQVRXJZJZ7QRA7HXPYYB6H5PTA3EAAJXJNZD7U",
    getNetwork: async () => "TESTNET",
    signTransaction: async (xdr) => {
      // Typically the application expects a signed XDR string.
      return xdr; 
    },
    signAuthEntry: async (entry) => {
      return "mock_signature_for_e2e_testing";
    }
  };
`;

export default freighterMock;
