/**
 * Lets the text boxes and drop-downs in a widget's body take a mouse press on
 * Innovator 14.0.25.
 *
 * In 14.0.25 the dashboard widget element listens for mousedown and calls
 * preventDefault() on every press outside its header, so dragging can only start
 * from the header. A cancelled mousedown also stops a text box from taking focus
 * and a native <select> from opening: the user clicks and nothing happens. 14.35
 * no longer cancels presses in the body.
 *
 * The widget element sits above the widget's own root, so stopping the press at
 * the root, for form controls only, keeps it away from that listener. Presses
 * anywhere else still reach it, so header dragging and resizing are unchanged.
 */

const FORM_CONTROLS = 'input, select, textarea, [contenteditable]';

/** Call once on the widget's root element. */
export const allowFormControls = (root) => {
	root.addEventListener('mousedown', (event) => {
		const target = event.target;
		if (target && typeof target.closest === 'function' && target.closest(FORM_CONTROLS)) {
			event.stopPropagation();
		}
	});
};
