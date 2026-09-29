// The app runs under the build base, the scope of its service worker and of
// the installed app: an entry through any other path moves inside it.
import { describe, it, expect } from 'vitest';
import { insideBase } from '@/lib/appBase';

describe('insideBase', () => {
	it('moves the bare domain and root-level routes under the base', () => {
		expect(insideBase('/', '/app/')).toBe('/app/');
		expect(insideBase('/chat/u_abc', '/app/')).toBe('/app/chat/u_abc');
		expect(insideBase('/account/info', '/app/')).toBe('/app/account/info');
	});

	it('completes the base itself written without its slash', () => {
		expect(insideBase('/app', '/app/')).toBe('/app/');
	});

	it('leaves a path already under the base alone', () => {
		expect(insideBase('/app/', '/app/')).toBeNull();
		expect(insideBase('/app/chat/u_abc', '/app/')).toBeNull();
	});

	it('does not take a path that only begins like the base for one inside it', () => {
		expect(insideBase('/application', '/app/')).toBe('/app/application');
	});

	it('has nothing to move when the app owns the whole host', () => {
		expect(insideBase('/chat/u_abc', '/')).toBeNull();
	});
});
