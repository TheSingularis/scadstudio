Render feedback and real model colors. Unsigned Linux AppImage and Windows portable exe attached.

What is new since beta-v0.1.6:

- **Real colors.** Models now show the colors their code gives them, including `color()` inside modules and booleans (a cut takes the cutter's color, as in OpenSCAD). Parts with no color keep the default blue. Named and hex colors (`color("goldenrod")`, `color("#d4a017", 0.5)`) show in the color picker, and a move keeps them as written.
- **Brighter, truer lighting.** The light now follows the camera, so the side you look at is lit and colors look like they do in OpenSCAD.
- **Selection over real colors.** A selected part keeps its color, with a tint and an outline in the selection color. Hovering a part lightens it.
- **Render progress.** A render that takes more than a moment greys out the model on screen and shows a progress bar with the elapsed time, which part it is on, and a Cancel button. Cancel keeps the last finished model.
- **Opening a file** clears the previous model right away and stops its render.
- **Focus (F).** Select a part and press F, or click Focus, to center the view on it without changing the angle. Text is turned to face you, level, so it reads straight.
- **Camera.** Sketch planes frame the whole model instead of a fixed distance. Leaving sketch mode returns to the view you had before, and a shape you just added (sketch or text) is centered in view.
