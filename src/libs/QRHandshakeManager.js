import QRCode from 'qrcode';
import QrScanner from 'qr-scanner';
import { randomBytes } from '@noble/post-quantum/utils.js';
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export default class QRHandshakeManager extends EventTarget {
	constructor(container, userPQ, options) {
		super();
		this.userPQ = userPQ;
		this.container = container;
		this.options = options;
		this.scanning = false;
		
		this.state = this.getInitialState();

		this.qrCode = null;
		this.qrScanner = null;
		this.init();
	}

	getInitialState() {
		return {
			step: 1, // 1: QR1(A), 2: QR2(B), 3: QR3(C), 4: Done
			myNonce: null,
			mySigPeerNonce: null,
			mySigHashNonce: null,
			peerHash: null,
			peerEccPub: null,
			peerNonce: null,
			completed: false,
		};
	}

	async init() {
		this.container.innerHTML = this.getTemplate();
		this.qrCodeWrapper = this.container.querySelector('._qrh_wrapper');
		this.qrCode = this.container.querySelector('#qrCode');
		this.qrScannerEl = this.container.querySelector('#qrScanner');
		
		this.qrScanner = new QrScanner(this.qrScannerEl, (result) => this.readQr(result.data), {
			returnDetailedScanResult: true,
			preferredCamera: 'user',
			highlightScanRegion: true,
			highlightCodeOutline: true,
			calculateScanRegion: (video) => {
				const width = video.videoWidth;
				const height = video.videoHeight;
				const scanSize = 0.95; // 95% of video size
				return {
					x: (width * (1 - scanSize)) / 2, // Center horizontally
					y: (height * (1 - scanSize)) / 2, // Center vertically
					width: width * scanSize,
					height: height * scanSize,
				};
			},
		});
	}

	getTemplate() {
		return `
        <div class="_qrh">
			<div class="_qrh_wrapper" id="qrCodeWrapper" >
				<div class="_qrh_container">
					<canvas id="qrCode"></canvas>
				</div>
			</div>
			<div class="_qrh_scanner" id="qrScannerWrap">
				<video id="qrScanner"></video>
			</div>
        </div>
      	`;
	}

	emitEvent(eventName, detail = {}) {
		this.dispatchEvent(new CustomEvent(eventName, { detail }));
	}

	async updateQr() {
		if (this.qrCode && this.state.myNonce) {
			const myHash = this.userPQ.currentUserHash;
			const myEccPubBytes = atob(this.userPQ.currentUser.contact_pkey);
			const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));
			
			let msg = '';
			let color = this.options.scanningColor;

			if (this.state.step === 1) {
				msg = `PQ1:A:${myHash}:${myEccPub}:${this.state.myNonce}`;
			} else if (this.state.step === 2) {
				msg = `PQ1:B:${myHash}:${myEccPub}:${this.state.myNonce}:${this.state.mySigPeerNonce}:${this.state.mySigHashNonce}`;
				color = this.options.detectedColor;
			} else if (this.state.step >= 3) {
				msg = `PQ1:C:${this.state.mySigPeerNonce}:${this.state.mySigHashNonce}`;
				color = this.options.verifiedColor;
			}

			QRCode.toCanvas(this.qrCode, msg, {
				errorCorrectionLevel: 'L',
				height: 360,
				width: 360,
				quality: 1,
				margin: 0,
				color: { dark: color },
			});
		}
	}

	stopScan() {
		if (this.qrScanner) {
			this.qrScanner.stop();
			this.scanning = false;
			const wrapper = this.container.querySelector('#qrCodeWrapper');
			if (wrapper) wrapper.style.display = 'none';
		}
	}

	async toggleScanner() {
		try {
			if (this.scanning && this.qrScanner) {
				this.qrScanner.stop();
				this.scanning = false;
				const wrapper = this.container.querySelector('#qrCodeWrapper');
				if (wrapper) wrapper.style.display = 'none';
				this.emitEvent('scanning', this.scanning);
				this.updateQr();
				return;
			}
			
			this.reset();
			this.scanning = true;
			this.emitEvent('scanning', this.scanning);
			await this.wait(100);
			await this.qrScanner.start();

			await this.showCountdown(3);

			this.state.myNonce = bytesToHex(randomBytes(16));
			const wrapper = this.container.querySelector('#qrCodeWrapper');
			if (wrapper) wrapper.style.height = 'unset';

			this.updateQr();
		} catch (error) {
			console.error('Init Scanning error:', error);
		}
	}

	async showCountdown(seconds) {
		for (let i = seconds; i > 0; i--) {
			this.emitEvent('handshakeCountdown', i);
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		this.emitEvent('handshakeCountdown', 0);
	}

	async readQr(msg) {
		try {
			if (!msg.startsWith('PQ1:')) return;
			const parts = msg.split(':');
			const type = parts[1];

			const myHash = this.userPQ.currentUserHash;
			const myEccPubBytes = atob(this.userPQ.currentUser.contact_pkey);
			const myEccPub = bytesToHex(Uint8Array.from(myEccPubBytes, c => c.charCodeAt(0)));

			if (type === 'A') {
				if (this.state.step >= 2) return;
				this.state.peerHash = parts[2];
				this.state.peerEccPub = parts[3];
				this.state.peerNonce = parts[4];
				
				// Generate signatures over raw bytes
				const peerNonceBytes = hexToBytes(this.state.peerNonce);
				this.state.mySigPeerNonce = await this.userPQ.signContactChallenge(peerNonceBytes);
				
				const hashBytes = new TextEncoder().encode(myHash);
				const hashPlusNonce = new Uint8Array(hashBytes.length + peerNonceBytes.length);
				hashPlusNonce.set(hashBytes);
				hashPlusNonce.set(peerNonceBytes, hashBytes.length);
				
				this.state.mySigHashNonce = await this.userPQ.signContactChallenge(hashPlusNonce);
				
				this.state.step = 2;
				if ('vibrate' in navigator) navigator.vibrate([50]);
				this.updateQr();

			} else if (type === 'B') {
				if (this.state.step >= 3) return;
				const peerHash = parts[2];
				const peerEccPub = parts[3];
				const peerNonce = parts[4];
				const peerSigNonce = parts[5];
				const peerSigHashNonce = parts[6];

				this.state.peerHash = peerHash;
				this.state.peerEccPub = peerEccPub;
				this.state.peerNonce = peerNonce;
				
				// Verify Sig(myNonce)
				const myNonceBytes = hexToBytes(this.state.myNonce);
				const isValid1 = secp.verify(hexToBytes(peerSigNonce), sha256(myNonceBytes), hexToBytes(peerEccPub));
				
				// Verify Sig(peerHash + myNonce)
				const peerHashBytes = new TextEncoder().encode(peerHash);
				const expectedHashPlusNonce = new Uint8Array(peerHashBytes.length + myNonceBytes.length);
				expectedHashPlusNonce.set(peerHashBytes);
				expectedHashPlusNonce.set(myNonceBytes, peerHashBytes.length);
				const isValid2 = secp.verify(hexToBytes(peerSigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(peerEccPub));
				
				if (isValid1 && isValid2) {
					// Generate signatures over raw bytes
					const peerNonceBytes = hexToBytes(peerNonce);
					this.state.mySigPeerNonce = await this.userPQ.signContactChallenge(peerNonceBytes);
					
					const myHashBytes = new TextEncoder().encode(myHash);
					const hashPlusNonce = new Uint8Array(myHashBytes.length + peerNonceBytes.length);
					hashPlusNonce.set(myHashBytes);
					hashPlusNonce.set(peerNonceBytes, myHashBytes.length);
					
					this.state.mySigHashNonce = await this.userPQ.signContactChallenge(hashPlusNonce);
					
					this.state.step = 3;
					this.finishHandshake();
					this.updateQr();
				} else {
					console.warn("Invalid signature from peer (B)");
				}

			} else if (type === 'C') {
				if (this.state.step !== 2) return;
				const peerSigNonce = parts[2];
				const peerSigHashNonce = parts[3];
				
				// Verify Sig(myNonce)
				const myNonceBytes = hexToBytes(this.state.myNonce);
				const isValid1 = secp.verify(hexToBytes(peerSigNonce), sha256(myNonceBytes), hexToBytes(this.state.peerEccPub));
				
				// Verify Sig(peerHash + myNonce)
				const peerHashBytes = new TextEncoder().encode(this.state.peerHash);
				const expectedHashPlusNonce = new Uint8Array(peerHashBytes.length + myNonceBytes.length);
				expectedHashPlusNonce.set(peerHashBytes);
				expectedHashPlusNonce.set(myNonceBytes, peerHashBytes.length);
				
				const isValid2 = secp.verify(hexToBytes(peerSigHashNonce), sha256(expectedHashPlusNonce), hexToBytes(this.state.peerEccPub));
				
				if (isValid1 && isValid2) {
					this.state.step = 4;
					this.finishHandshake();
					this.updateQr();
				} else {
					console.warn("Invalid signature from peer (C)");
				}
			}
		} catch (error) {
			console.error('readQr error:', error);
		}
	}

	finishHandshake() {
		if (this.state.completed) return; // Prevent double trigger
		this.state.completed = true;
		
		if ('vibrate' in navigator) navigator.vibrate([500, 100, 500, 100, 500]);
		
		this.qrScanner.stop();
		
		// Lookup user in network to get name if available
		const networkUser = this.userPQ.allNetworkUsers.find(u => u.user_hash === this.state.peerHash);
		const name = networkUser ? networkUser.name : 'Unknown User';

		// Emit candidate details for UI to show
		this.emitEvent('handshakeCompleted', {
			user_hash: this.state.peerHash,
			contact_pkey: btoa(String.fromCharCode(...hexToBytes(this.state.peerEccPub))), // Re-encode to base64
			name: name
		});
		
		this.scanning = false;
		this.emitEvent('scanning', this.scanning);
	}

	dispose() {
		try {
			if (this.qrScanner) {
				this.qrScanner.dispose();
			}
		} catch (error) {
			console.error(error);
		}
	}

	reset() {
		this.state = this.getInitialState();
	}

	wait(delay = 500) {
		return new Promise((resolve) =>
			setTimeout(() => {
				resolve();
			}, delay)
		);
	}
}
