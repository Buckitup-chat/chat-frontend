// Legacy accounts may still reference media by bare IPFS CID. Resolve those
// through a public gateway (the private Infura gateway is gone); everything
// else is returned as-is.
const PUBLIC_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

export const mediaUrl = (url, def) => {
    if (!url) return def

    const ipfsCidPattern = /^(Qm[a-zA-Z0-9]{44}|bafy[a-zA-Z0-9]{48,})$/;

    if (ipfsCidPattern.test(url)) {
        return `${PUBLIC_IPFS_GATEWAY}${url}`;
    }

    return url; // Return original if not an IPFS CID
};
