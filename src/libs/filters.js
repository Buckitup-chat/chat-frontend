export default {
	txHashShort(txHash) {
		if (txHash && txHash.length > 15) {
			return `${txHash.substring(0, 8)}.....${txHash.substring(txHash.length - 6)}`;
		}
		return txHash || '.....';
	},

};
