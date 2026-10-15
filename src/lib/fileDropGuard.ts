// A file dropped where nothing takes it would be opened by the browser in
// place of the app — the dialog, the session and any unsent text gone. The
// guard cancels file drags everywhere; a drop target (the dialog pane) has
// already cancelled the event and set its own effect on the way up, which
// the guard leaves alone.

const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

export const installFileDropGuard = (target: Pick<Window, 'addEventListener'> = window): void => {
	target.addEventListener('dragover', (e: DragEvent) => {
		if (!carriesFiles(e) || e.defaultPrevented) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
	});
	target.addEventListener('drop', (e: DragEvent) => {
		if (carriesFiles(e)) e.preventDefault();
	});
};
