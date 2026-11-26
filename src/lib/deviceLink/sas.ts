/**
 * The six digits both devices derive from a link session, split the way the
 * sending device shows them: the outer pairs on screen, the middle pair typed
 * by the person from the new device.
 */
export const splitSas = (sas: string) => ({ head: sas.slice(0, 2), middle: sas.slice(2, 4), tail: sas.slice(4) });
