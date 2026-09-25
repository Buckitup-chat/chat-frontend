/**
 * Hands bytes to the browser's save flow.
 *
 * The revoke is deferred rather than immediate: Safari reads the object URL
 * asynchronously after the synthetic click, and revoking in the same tick
 * cancels the download there while working everywhere else.
 */
export default function downloadFile(data, filename, mimeType = 'application/octet-stream') {
	const url = URL.createObjectURL(new Blob([data], { type: mimeType }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
