export default {
	txHashShort(txHash) {
		if (txHash && txHash.length > 15) {
			return `${txHash.substring(0, 8)}.....${txHash.substring(txHash.length - 6)}`;
		}
		return txHash || '.....';
	},

	secondsToHMS(value) {
		//const sec = parseInt(value, 10); // convert value to number if it's string
		//let hours   = Math.floor(sec / 3600); // get hours
		//let minutes = Math.floor((sec - (hours * 3600)) / 60); // get minutes
		//let seconds = sec - (hours * 3600) - (minutes * 60); //  get seconds
		//// add 0 if value < 10; Example: 2 => 02
		//if (hours   < 10) {hours   = "0"+hours;}
		//if (minutes < 10) {minutes = "0"+minutes;}
		//if (seconds < 10) {seconds = "0"+seconds;}
		//return hours+':'+minutes+':'+seconds; // Return is HH : MM : SS

		if (!value) return 0;

		let seconds = Number(value);
		var d = Math.floor(seconds / (3600 * 24));
		var h = Math.floor((seconds % (3600 * 24)) / 3600);
		var m = Math.floor((seconds % 3600) / 60);
		var s = Math.floor(seconds % 60);

		var dDisplay = d > 0 ? d + ` day${d > 1 ? 's' : ''} ` : '';
		var hDisplay = h > 0 ? h + ` hour${h > 1 ? 's' : ''} ` : '';
		var mDisplay = m > 0 ? m + ` minute${m > 1 ? 's' : ''} ` : '';
		let sDisplay = '';
		if (d == 0 && h == 0 && m == 0 && s) {
			sDisplay = s > 0 ? s + ` second${s > 1 ? 's' : ''} ` : '';
		}
		//;
		return (dDisplay + hDisplay + mDisplay + sDisplay).trim(); // + sDisplay;
	},
};
