// The app uses qrcode untyped as well; this page needs only toCanvas.
declare module 'qrcode' {
	const QRCode: {
		toCanvas(canvas: HTMLCanvasElement, text: string, options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'; margin?: number; width?: number; scale?: number }): Promise<void>;
	};
	export default QRCode;
}
