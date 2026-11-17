# Set2Print

Turn a brick set's parts list into ready-to-print 3MF plates, one batch per colour.

**Use it:** https://smeef123.github.io/set2print/

- Type a set number or part of its name: every official set is built in (no account or key), refreshed every Monday from Rebrickable's free database downloads by `scripts/build_data.py`. Minifigure parts are included.
- Or paste/upload any parts list (`part, colour, quantity`; Rebrickable CSV exports work as they are).
- Every part is fetched from the LDraw parts library, converted to millimetres, turned studs-up, and laid out on plates per colour (Bambu X1/P1 corner no-print zone avoided).
- The page opens on an empty 256 × 256 mm build plate; once built, every plate shows in 3D with a tab per plate.
- You download one Bambu Studio project (.3mf) with every plate in it, one filament per colour, Lego settings already set. STLs and notes are a separate optional download.
- Everything runs in your browser. Nothing is uploaded.

## Automatic supports

Print with slicer supports **off**. Set2Print decides supports by geometry:

- A point on a part's underside prints as is if it lies on a straight path of at most **20 mm** between two pieces of material 0.3 mm below it (a bridge), or within **1 mm** of material below it (an overhang stepping out per layer, which allows slopes up to about 73° from vertical). These are the ordinary bands for PLA on a Bambu P-series printer.
- The part is also sliced into 0.2 mm layers; any region that starts in mid-air (overlaps nothing in the layer below) fails too, however close it sits to a wall.
- Studs-up is kept unless turning leaves less than half the unsupported area it does (after pillars), and a turned part must stand steadily (no taller than 2.5× its narrowest footprint side).
- Every spot that still fails gets a **breakaway pillar**: a column from the plate (or the part below) up to 0.2 mm short of the underside, kept 0.3 mm clear of the part's sides and at least 0.8 mm wide. This covers flat and curved undersides such as sideways studs.
- Anything pillars can't reach gets breakaway fins from the [Support Fins](https://printfins.com) engine (vendored unchanged in `vendor/support-fins`, MIT).
- `supports.txt` in the download lists every part that was turned, pillared or finned, and anything left that still needs care.

## Lego print settings (written into every plate)

Plates for 256 mm beds (Bambu P1S, P1P, X1, P2S) carry a complete Bambu Studio profile, so they open and slice with these values. Each value is kept only where the sources agree:

| Setting | Value | Evidence |
|---|---|---|
| Orientation | studs up, hollow side on the plate, no slicer supports | [Prusa blog](https://blog.prusa3d.com/how-to-make-3d-printed-lego-and-lego-duplo-parts_31741/), [MachineBlocks](https://machineblocks.com/docs/get-started), [Brickset test](https://brickset.com/article/128767/can-you-make-compatible-bricks-with-consumer-3d-printers), MikeMakess (P1S, YouTube) |
| Brim | none | the user's fit test: a brim was hard to remove and left a lip at the base |
| Studs | 4.90 mm across, 1.3 mm tall (LDraw's 16-sided 4.71 x 1.6 mm studs replaced; tubes 6.51 mm) | printed studs must be oversize: MachineBlocks 5.00, LEGO.scad presets 4.94-5.03, brickify 4.85, OpenSCADLEGO ~5.09; hollows need room above studs: MachineBlocks +0.6 mm, brickify +0.2 mm |
| Layer height | 0.20 mm (default) or 0.10 mm fine | 0.20: MachineBlocks, MikeMakess, Brickset (slightly better clutch than 0.10). 0.10: [Klemmbrick](https://makerworld.com/en/models/1954190-klemmbrick-legos-compatible-bricks), Brickset and MikeMakess for a smoother finish |
| Walls | 3 loops, Arachne, outer wall first | [Printpal](https://blog.printpal.io/design-and-3d-print-your-own-lego-compatible-bricks/) (3-4 perimeters), Klemmbrick (Arachne, outer-inner) |
| Seam | back | Klemmbrick |
| Infill | 15% | MachineBlocks, Bambu default |
| Material | PLA | MachineBlocks, Printpal, MikeMakess, Brickset |
| X-Y compensation | 0 | sources disagree in direction ([Meshy](https://www.meshy.ai/blog/lego-compatible-3d-print-tolerances) shrinks studs; a [stud test](https://makerworld.com/en/models/1007391-leg0-brick-stud-size-test) needed them bigger): calibrate on your printer instead |
| Elephant-foot compensation | 0.15 mm (Bambu's P1S value) | Prusa suggests 0.4 mm, measured on Prusa printers; raise it if the bottom rim won't slide over studs |

Every source agrees printed bricks clutch less than real ones and that a quick fit test on your own printer beats any default.

## Fit test

Build the fit-test plate (a 2x4 brick and a 2x4 plate, about 20 minutes), try it on real bricks, and report each fit as too tight, just right or too loose. Studs are outer contours, so they move **X-Y contour compensation**; the hollow underside is a hole in every layer, so it moves **X-Y hole compensation**. Each report moves the matching value 0.05 mm (limit ±0.3 mm); the values are kept in your browser and written into every plate you build.

## Credits

- Support fins: [Support Fins](https://github.com/gittrahan/support-fins) engine, MIT.
- Part geometry: [LDraw.org](https://www.ldraw.org) parts library, CC BY 2.0, by its many authors (served from [gkjohnson/ldraw-parts-library](https://github.com/gkjohnson/ldraw-parts-library)).
- Set inventories and colours: [Rebrickable](https://rebrickable.com).
- Loader: [three.js](https://threejs.org) LDrawLoader. Zip: JSZip.

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project. For personal use.

## License

MIT for this code. Part geometry keeps its own CC BY 2.0 licence.
