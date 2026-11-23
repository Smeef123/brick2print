# Printing research applied to Set2Print

Every finding in the printing research that could bear on printed bricks or on what Set2Print writes,
checked against the code (2026-11-22). Sources: `SKILL` = `C:\Users\Connor\.claude\skills\fdm-printing\SKILL.md`,
`digests/` = `C:\Users\Connor\tools\print-research\digests\`, `memory/` = the session's measured-reference notes
(lego-geometry-references.md, patterns-from-errors.md). "Measured" numbers come from `audit/out/measure_all.mjs`
run on the meshes the site builds (before = commit d2b887c, after = this commit); slicer results are from the
Bambu Studio CLI. Where sources disagree the row says which one was taken and why.

Statuses: **done** (already in the site before this change, code cited), **applied** (added in this change),
**not applied** (with the reason).

## Geometry

| # | Finding | Source | Status |
|---|---|---|---|
| 1 | LDraw display studs are undersized 16-gons (4.71 mm) and must be replaced before printing; fix at the shared primitive, not per part | SKILL:286-287; memory/patterns-from-errors ("Display models are not manufacturing models") | done for `stud.dat` and the tube `stud4.dat`. **applied**: the tube variant `stud4a` (16 of the 415 audited parts) now gets the same tube (parts.js:56-61). Tried and reverted for open studs `stud2`/`stud2a`: the sideways open studs of 4070 and 87087 then sliced with 0.4-0.9 mm2 starting in mid-air (3 runs each), 0/0/0 with LDraw's own; open studs stay LDraw's 4.708 mm |
| 2 | Printed studs must be oversize: 4.85-5.1 mm; MachineBlocks 5.00, Klemmbrick 5.04 (FDM, measured, 2,800+ prints), LEGO.scad 4.94-5.03, brickify 4.85 | SKILL:285, 295-297; memory/lego-geometry-references | **applied**: 4.90 -> 5.00 mm (parts.js:20). Both FDM-proven references agree to 0.04 mm; took MachineBlocks' 5.00 (the lower one, fit test adds more). Measured 3001/3020/3003/3024: 4.900 -> 5.000 |
| 3 | Stud height 1.6-1.8 mm (MachineBlocks 1.6, Klemmbrick 1.8) | SKILL:296 | done (parts.js:27, 1.7 mm; was uncommitted work, committed now). Measured 1.300 -> 1.700 |
| 4 | 0.2-0.6 mm room above studs inside a hollow | SKILL:285-286 | done: plate hollow 2.2 - stud 1.7 = 0.5 mm (parts.js:105-114). Measured: hollow 2.200, stud 1.700 |
| 5 | Plate hollow 2.2 mm deep under a 1.0 mm roof (MachineBlocks; LDraw 1.6 under 1.6) | SKILL:297; memory/lego-geometry-references | done (parts.js:226-259, uncommitted work committed now). Measured 3020: 1.600/1.600 -> 2.200/1.000; 3024 the same |
| 6 | Footprint 0.075-0.1 mm smaller per side than the 8 mm grid (2x4 = 31.8 x 15.8; LDraw 32.0) | SKILL:296 | done (parts.js:114, `SIDE_GAP` 0.1; round parts parts.js:205). MachineBlocks 0.1 vs Klemmbrick 0.075: both FDM, took 0.1 (code value, Klemmbrick's is read off a preview mesh). Measured 3001: 32.000 x 16.000 -> 31.800 x 15.800; 1x1 round 3062b 8.000 -> 7.800. **applied** (fix): the gap used to move only the wall faces that passed the inside test, leaving 0.1 mm slivers (3659: a strip at y = -3.95 starting in mid-air at z 1.4, 7.5 mm2) and side studs 0.1 mm off their wall (87087). Now a wall plane moves whole, with everything standing up to 2 mm out of it, and a plane with other geometry on it (98263's ball socket) keeps its full size (parts.js:113, 179-201). Support check after: 3659, 87087, 4070 "prints as is" (d2b887c: the same) |
| 7 | Tube outer diameter: MachineBlocks 6.41, Klemmbrick 6.53, LEGO.scad 6.45, LEGO 6.51 | memory/lego-geometry-references | not applied: kept 6.51 (parts.js:20). The FDM references disagree by 0.12 mm; 6.51 sits with Klemmbrick's measured 6.53, and the user's first fit test with LDraw's 6.40 tubes didn't clutch. Measured 6.510 before and after |
| 8 | Outer wall: MachineBlocks 1.5 (+0.1 ribs), Klemmbrick 1.2 | memory/lego-geometry-references | done: LDraw's 1.6 wall minus the 0.1 side gap = 1.5 (from the code, not measured) |
| 9 | Brick roof 1.6, cavity 8.0 (Klemmbrick) | memory/lego-geometry-references | done (LDraw's own). Measured 3001: hollow 8.000, roof 1.600 |
| 10 | 1xN underside pin (`stud3`, 64 audited parts) | no research number | not applied: none of the references give a printed pin size; left as LDraw's 16-gon (noted in parts.js:15) |
| 11 | Source meshes are often not watertight; hand-made primitives can be wound inside-out without any slicer complaining | memory/patterns-from-errors | **applied**: every replaced stud and tube is turned outward if it came out inside-out (parts.js:50-56, 263-289); upside-down tubes in 3062a and 85861 came out inside-out through three.js. Studs stay open at the bottom where they stand on the top face, as before (3001: 768 open edges before and after); closing them with a bottom face was tried and reverted: the support check read those faces as undersides and put 24 pillars on the 6x8 plate 3036 (0.6 s -> 119 s) |
| 12 | Nominal zero-clearance dimensions never survive printing; zero clearance is a transition fit | memory/patterns-from-errors; digests/tolerances-fits.md:18 | done: oversize studs, side gap, headroom (rows 2-6) |

## Orientation and supports

| # | Finding | Source | Status |
|---|---|---|---|
| 13 | Studs up, hollow side on the plate, slicer supports off | SKILL:286; digests/lego-printing.md:37 (Prusa) | done (supports.js pose rule; export3mf.js:27 `enable_support` 0) |
| 14 | Fins, not tree supports (user rule); fins report what they can't reach, then tilt | SKILL:15-16, 63-64 | done (supports.js `autoSupport`: pose, pillars, Support Fins) |
| 15 | Bambu: add support below about 45 deg from horizontal | SKILL:121 | not applied: the site allows a 1 mm step per 0.3 mm (supports.js:21-22), tuned against Bambu Studio slices of 415 parts (audit). Changing it needs a new audit and the user's decision |
| 16 | Bridges: raise bridge flow (1.4-1.6) and slow down; thick bridges for long spans | SKILL:123-125 | not applied: the plate-hollow roof is the only bridge that matters for fit and its 0.5 mm headroom covers sag; no brick-specific evidence |
| 17 | Plain PLA as its own interface needs about a 0.2 mm gap | SKILL:62 | done (supports.js:242, pillar top gap 0.2) |
| 18 | Print-in-place clearance 0.2-0.3 mm works on Bambu printers | SKILL:312, 518; digests/joint-tolerance-pip.md:5 | done (supports.js:242, pillar side clearance 0.3) |
| 19 | Set "slice gap closing radius" to 0.03 so close parts don't fuse | SKILL:313; digests/snap-fits-hinges.md:17 | not applied: the base 0.049 closes gaps under about 0.1 mm; the site's smallest gaps are 0.2 (vertical) and 0.3 mm |
| 20 | Support XY distance 0.38-0.5 mm for clean removal | SKILL:534, 590 | not applied: a tree-support setting for figures; pillars are part of the mesh |
| 21 | Judge "floating" warnings by the sliced result, not the warning | SKILL:427-429 | done (audit/worker.mjs:46, mid-air area from G-code) |
| 22 | CLI slices vary run to run: judge by the median of 3 | SKILL:29 | done (audit/run.mjs:26, 84) |
| 23 | Details in the X-Y plane print sharpest | SKILL:593 | done: studs up puts every stud circle in X-Y |
| 24 | Loads across layer lines are the weak case | SKILL:78 | done: studs up keeps clutch stress in the walls' own layers |
| 25 | Tilt figures 30-45 deg | SKILL:468, 497 | not applied: figures; bricks need vertical clutch faces |

## Slicer settings written into every plate

| # | Finding | Source | Status |
|---|---|---|---|
| 26 | 0.20 mm layers (better clutch) or 0.10 fine (Klemmbrick) | SKILL:286; README | done (export3mf.js:34; index.html:129) |
| 27 | Bricks that don't clutch -> lower layer height (MikeMakess) vs 0.20 clutches better (Brickset) | SKILL:288-289 | not applied: conflicting and untested; both heights stay offered |
| 28 | 3 wall loops; walls beat infill | SKILL:77, 286 | done (export3mf.js:21) |
| 29 | Arachne (Klemmbrick) vs Classic (MADOS); Arachne keeps small details but leaves more seams | SKILL:286, 291-293, 476-478; digests/arachne-small-details.md:11 | done: Arachne (export3mf.js:22). Klemmbrick is measured on brick-compatible parts; MADOS is a different joint system |
| 30 | Arachne ignores painted seams; wrong wall order in Studio 1.7.2.51 | digests/arachne-small-details.md:20, 29 | not applied: the site sets seam position, not painting; the project declares Studio 02.09.01.70 |
| 31 | Outer wall first (Klemmbrick; avoids a bulge at steps) | SKILL:286, 318 | done (export3mf.js:23). Inner-first (SKILL:544) is a figure setting |
| 32 | Seam at the back (Klemmbrick); seam options | digests/studio-hidden-features.md:53 | done (export3mf.js:24) |
| 33 | A protruding seam limits fit; give it a recess | digests/tolerances-fits.md:15 | done in part: seam at the back, off the stud faces; no recess geometry (would change every part) |
| 34 | 15% infill | README (MachineBlocks) | done (export3mf.js:25) |
| 35 | No brim (user's fit test) vs brim (Prusa; MikeMakess for corner warp) | SKILL:288-289; digests/lego-printing.md:37 | done (export3mf.js:26): the user's own test wins. **applied**: the page said "outer brim" and "gap leaves room for a brim"; fixed (index.html:133-134) |
| 36 | Elephant-foot compensation: Bambu default fine, calibrate for tight fits; guides 0.1-0.2; Prusa 0.4 on Prusa printers | SKILL:106-107, 302, 433; digests/elephant-foot.md:30, 37 | done: 0.15 from the Bambu P1S base (bambu/p1s-base.json `elefant_foot_compensation`); took Bambu's own value for these printers over Prusa's. **applied**: fit-test text says when to raise it toward 0.2 (index.html:141) |
| 37 | Avoid crossing walls reduces stringing; long travels string | SKILL:95 | **applied**: `reduce_crossing_wall` 1 (export3mf.js:28). Slicer result in "Checks" below |
| 38 | First layer: about 1/4 nozzle minimum | SKILL:106; digests/first-layer.md:33 | done: 0.2 mm first layer (base `initial_layer_print_height`) |
| 39 | Choose the right plate type (Textured PEI changes nozzle offset and bed temperature) | SKILL:102-103 | done (base `curr_bed_type` Textured PEI Plate, the user's plate) |
| 40 | Arc fitting cuts vibration | SKILL:221 | done (base `enable_arc_fitting` 1) |
| 41 | Ironing risks heat creep; skip on small tops | SKILL:188, 364-366 | done (base: no ironing) |
| 42 | Outer wall 30-40 mm/s for show surfaces; acceleration <= 10000 with resonance warnings | SKILL:36, 227 | not applied: ringing advice for tall glossy parts and the user's own printer; no fit evidence |
| 43 | Hotter, less cooling for layer bonding | SKILL:79 | not applied: Generic PLA defaults kept; no brick evidence |
| 44 | Bambu holes print 0.15-0.2 mm small at 0 compensation; 0.1 fixes circles, not squares | SKILL:173; digests/tolerances-fits.md:5 | not applied as a default: one X1C report, and brick hollows are square; the fit test sets hole compensation per printer |
| 45 | Project presets live only in the .3mf | SKILL:282 | done (export3mf.js projectFile writes project_settings.config) |
| 46 | MakerWorld rejects "Lego" in titles, tags and profiles | SKILL:302-303; digests/lego-printing.md:5-14 | **applied**: the embedded profile is named "Set2Print Bricks 0.2mm" instead of "... Lego ..." (export3mf.js:37), so a shared project isn't refused |

## Fit testing and the page's instructions

| # | Finding | Source | Status |
|---|---|---|---|
| 47 | Do a fit test on your own printer; X-Y contour compensation moves studs, hole compensation moves hollows | SKILL:294 | done (app.js:237-254, 0.05 mm steps, limit 0.3) |
| 48 | Test-print a small slice of the mating feature first | SKILL:175; digests/tolerances-fits.md:15 | done: the fit test is one 2x4 brick and one 2x4 plate (app.js:265) |
| 49 | Printed-on-printed clutches tighter than printed-on-real (layer lines interlock) | SKILL:300-301; digests/lego-printing.md:18 | **applied**: fit-test text says to also try two printed parts (index.html:141) |
| 50 | Fit shifts with colour, material, brand (Slant 3D; MADOS strengths 0-9) | SKILL:171-172, 291-292; digests/tolerances-fits.md:34 | **applied**: fit-test text says to test again after switching filament (index.html:141) |
| 51 | Scaling a part by % is the wrong fix when only the hole or the outside is off; use hole/contour compensation | digests/tolerances-fits.md:40 (CHEP) | **applied**: the page told users to try 99.5% scale; now points to the fit test (index.html:134) |
| 52 | Tolerance tests in 0.05 mm steps | digests/tolerances-fits.md:43 | done (app.js:237) |
| 53 | Round corners, chamfer bottom edges, mating chamfers | SKILL:128, 174 | not applied: would change every LDraw part's shape; elephant-foot compensation handles the first-layer flare; no brick reference does it |
| 54 | First layer decides the fit; wash the plate with dish soap, not IPA | SKILL:67-68, 104-105; digests/lego-printing.md:37 | **applied**: "Before printing" hint (index.html:135) |
| 55 | P1S + Textured PEI at 55 C with PLA: open the door or lift the glass (heat creep) | SKILL:41, 154-156 | **applied**: same hint |
| 56 | Plain PLA; Matte is brittle, Silk weak; cheap PLA works | SKILL:203-205, 344-347; digests/lego-printing.md:40 | **applied**: same hint. Profile stays Generic PLA (base) |
| 57 | FDM is poor for tiny parts (minifigure hands), good for big special parts | digests/lego-printing.md:37 | **applied**: same hint |
| 58 | Sport/Ludicrous speed loses detail on small parts | SKILL:222 | **applied**: same hint |
| 59 | Put parts closer to cut stringing | SKILL:95 | **applied** as advice (index.html:134); default gap kept at 12 mm: the research gives no number |
| 60 | Switching the printer profile can throw parts off their plates | SKILL:440-441 | **applied**: footer says pick the printer first (index.html:172); footer also corrected (it described per-plate 3MFs and STLs the site no longer writes) |
| 61 | Tiny parts are slowed by minimum layer time: print several at once | SKILL:220 | done: plates are packed full per colour (layout.js:4) |
| 62 | Fill plates with copies to save purges | SKILL:148 | done: one colour per plate |

## Not applicable to what the site makes

| # | Finding | Source | Why |
|---|---|---|---|
| 63 | 0.2 nozzle for small text and fine detail; 0.08 layers | SKILL:419, 458-466, 519 | the site writes a 0.4-nozzle profile; LDraw bricks carry no printed text |
| 64 | Snap hinges: 45 deg lead-in, 1 wall on the flexing arm | SKILL:313-314 | clips and hinges are LDraw geometry; per-feature wall counts would need a feature detector and there is no brick evidence |
| 65 | Magnet holes (10x3 -> 10.3x3.1) | SKILL:354 | no magnets in brick parts |
| 66 | Textured plate initial layer 0.3 for print-in-place | SKILL:360 | single source, articulated figures |
| 67 | Cool Plate at 35 C avoids heat creep | SKILL:41 | the user prints on Textured PEI (SKILL:14) |
| 68 | Brim at gap 0 still separates with EFC on | SKILL:117 | no brim |
| 69 | Drying, wet-filament stringing, AMS, calibration order, maintenance | SKILL:47-49, 72-74, 93, 163-168, 177-181, 322-326 | printer and filament care, not part of the output |
| 70 | PETG, ASA/ABS, TPU, CF, nylon | SKILL:38-45, 130-144, 193-200, 304-311 | the site writes PLA (real bricks are ABS, but ABS is hard to print well: digests/lego-printing.md:40) |
| 71 | Annealing | SKILL:272-275 | shrinks X-Y and grows Z: would ruin the fit |
| 72 | Fuzzy skin, variable layers, vase mode, lithophanes, painting, glue | SKILL:189, 240-250, 361-369, 621-629 | not relevant to bricks |
| 73 | Orientation change to stop printed-on-printed binding (needs supports) | digests/lego-printing.md:18 | studs-up keeps the clutch faces; fit test handles tightness |

## Fit settings decided

Studs 5.00 mm across x 1.7 mm tall, tubes 6.51 mm, footprint 0.1 mm in per side, plate hollows 2.2 mm under
a 1.0 mm roof, elephant-foot compensation 0.15 mm, X-Y contour and hole compensation 0 until the user's own
fit test moves them in 0.05 mm steps. Every number is one measured on the meshes the site writes (table above
and below); none of them has been printed and fit-tested yet.

## Checks

Measured with `audit/out/measure_all.mjs` (sections through the mesh: stud diameter at mid-stud height to the
flats, tube diameter 1 mm above the plate, hollow depth to the lowest ceiling), before = d2b887c, after = this
commit, same LDraw library:

| Part | Footprint mm | Stud dia / height mm | Tube OD mm | Plate hollow / roof mm |
|---|---|---|---|---|
| 3001 brick 2x4 | 32.000 x 16.000 -> 31.800 x 15.800 | 4.900 / 1.300 -> 5.000 / 1.700 | 6.510 -> 6.510 | brick: 8.000 / 1.600 both |
| 3020 plate 2x4 | 32.000 x 16.000 -> 31.800 x 15.800 | 4.900 / 1.300 -> 5.000 / 1.700 | 6.510 -> 6.510 | 1.600 / 1.600 -> 2.200 / 1.000 |
| 3024 plate 1x1 | 8.000 -> 7.800 | 4.900 / 1.300 -> 5.000 / 1.700 | - | 1.600 / 1.600 -> 2.200 / 1.000 |
| 85861 round plate 1x1, open stud | 8.000 -> 7.800 | 4.708 / 1.600, unchanged (open studs stay LDraw's) | - | - |
| 3062b round brick 1x1 | 8.000 -> 7.800 | 4.708 / 1.600, unchanged (open stud) | - | - |

The same numbers were read back from the objects inside the written project file for set 10696 (3001, 3003,
3004, 3020, 3062b, 3710), not only from the in-memory meshes. No non-manifold edges on any measured part.

Slicing (Bambu Studio CLI, P1S profile written by the site, slicer supports off):

- `node audit/test_project.mjs` (4-plate, 3-colour project: 3001, 3020, 3005; serves the LDraw library itself
  through audit/ldraw.mjs): PASS, every plate on its own filament.
- Set 10696 (Medium Creative Brick Box, 92 unique parts, 35 plates) built headless and sliced with
  `node audit/build_set.mjs 10696 <dir> --slice 3`: one CLI run per plate, 3 runs each, 180 s limit per run
  (the CLI sometimes stalls at start-up: one thread, under 1 s CPU, no log), all 105 runs sliced. The G-code
  header confirms `reduce_crossing_wall = 1`, `brim_type = no_brim`, `elefant_foot_compensation = 0.15`,
  `wall_generator = arachne`, `seam_position = back`.
- Mid-air area is read from the G-code by audit/gcode.mjs (worker.mjs's method, plus arcs followed along the
  arc). The slicer itself is not repeatable: identical files gave plate 3 786.7-1,459.6 mm2 and plate 9
  94.3-146.7 mm2 across 3 runs, so versions are compared by the median of 3 and a plate counts as clean when all
  3 slice and the median is under 0.5 mm2.
- Result, d2b887c vs this commit (median of 3, same method): clean plates 26 vs 26 of 35; total median mid-air
  1,753.5 vs 1,733.0 mm2; 2,007 vs 2,109 min estimated (+5.1%: bigger, taller studs and crossing-wall travel).
  Changed: plate 21 0.6 -> 0 (cleaner), plate 25 0 -> 0.9: its 85984 slope reads 0-0.4 mm2 per run at both
  versions (3 single-part runs each: d2b887c 0.2/0/0.4, now 0.4/0.4/0), so that one is slicer noise.
- Single parts, 3 runs each, mid-air mm2: 3659 0/0/0, 87087 0/0/0, 4070 0/0/0 (before the fixes in this
  round: 3659 5.5/5.5/3.3, 87087 0.2/0.2/0, 4070 0.4/0/0.7).
- What caused those: the side gap moved only some faces of a wall (3659 kept 0.1 mm slivers starting in
  mid-air at z 1.4; 87087's side stud was left 0.1 mm off its wall); the replaced open stud made the sideways
  open studs of 4070 and 87087 start small regions in mid-air. Fixed by moving whole wall planes (or none)
  and by keeping LDraw's open studs.
- Support check time: 92438 (8x16 plate) took 1,340-1,354 s in `autoSupport` (not compared with d2b887c); the
  6x8 plate 3036 0.6 s. Cause (fa493b3): the replaced stud and tube files weren't marked Primitive, so three.js
  dropped the placement of the stug-* grids that hold them; 92438's studs and tubes piled up mid-part and its
  64 mm roof read as 6,082 mm2 unsupported, then every pillar cell scanned all 117,532 triangles. Now 2.1 s,
  "prints as is", sliced 3x: 0 mm2. 29 of the 415 audited meshes changed with that fix.
- Plate hollows (7926c38): walls ending on a ceiling's edge stayed at 1.6 mm when the ceiling moved to 2.2
  (3068b's tube hole, 15535's rim); 28 of 415 meshes changed.
- The site in headless Chrome: `node audit/test_site.mjs [local|url]` (every visitor path, downloads sliced).
- 415-part audit rerun 2026-11-22 (`audit/run.mjs`, mid-air from audit/gcode.mjs, code at 1251c7e, before the
  hollow fix; results in audit/out/results-midair-all.jsonl): 370 sliced, 45 not in LDraw. Zero mid-air: plain
  studs-up 242, what the site ships (decisions.json applied) 287. Left: 25 parts the rule itself reports as
  still unsupported (gears, propellers, technic panels); 38 the rule calls fixed or that ship plain with mid-air
  of their own (largest 64782 470.8, 15458 235.4, 30489 176.6 mm2); 9 in the slicer's noise band (under 0.5);
  5 that don't slice (3811 and 4186 are bigger than the bed, the site marks them too big; 2361Mx and 16965
  "object conflicts"; 2371 ran past the audit's new 1.5 GB slicer limit, it took 8.6 GB per slicer). 8 parts
  shipped worse than plain studs-up (50950, 4476, 61903, 15535, 30240, 47456, 47847, 3940b): all were turned or
  pillared although studs-up sliced at 0-0.2 mm2 (61903 is the same mesh both ways: slicer noise).
  decisions.json regenerated with audit/decisions.py: +15535 2371 30240 3940b 4476 47456 47847 50950,
  -3829c01 3963 6126a 64448. 15535 itself was the torn hollow above and now prints as is.

Not tested: a real print and fit test of any of these numbers.

## For the user to decide: the support check flags parts that print fine studs-up

From the 415-part audit (audit/out/results-midair-all.jsonl, 2026-11-22; "clean" = plain studs-up sliced with
under 0.5 mm2 starting in mid-air, median of up to 3 Bambu Studio CLI slices). Thresholds were not changed.

- 365 parts sliced studs-up. The check flagged 193 (2 mm2 or more unsupported studs-up); 88 of those slice
  clean plain. It passed 172; the slicer found 0.5 mm2 or more on 6 of them (36083f 0.5, 4265a 1.2, 4286 0.5,
  4533 0.6, 59443 0.5, 6014b 33.3).
- On the 88 clean parts the check predicted a median of 18.8 mm2 unsupported (largest real ones: 2479 427,
  4176 239, 2850a/2850b 216, 59349 206, 95347 204, 4476b 177, 3940b 172, 6134 166, 33121 153, 60581 139 mm2;
  2371's 8,700 was the wrong part, fixed in 237ad95).
- What it did with them: 19 were turned onto another side (50950 92818c01pr0002 40244 95347 584 2852 15535
  47456 92820c01pr0009 11403c01pr0106 92820c01pr0153 2417 47847 3940b 64179 6536 2853 87697 60594), the rest
  got pillars. 13 came out worse than plain studs-up: 50950 1.3, 92818c01pr0002 6.0, 4476b 1.4, 95347 283.2,
  2852 10.3, 15535 31.9 (a torn hollow, fixed), 47456 1.4, 92820c01pr0009 5.7, 11403c01pr0106 6.1,
  92820c01pr0153 5.7, 47847 3.9, 3940b 6.1 mm2, and 2371 (wrong part). decisions.json now prints those plain.
- So for audited parts the decisions file covers it; for parts outside the audit the check over-flags about
  half of what it flags (88 of 193), and turning a clean part is the step that does harm (11 of the 19 turned
  clean parts got worse). Options: raise MIN_FAIL_MM2, widen the bridge or overhang bands, or never turn a
  part whose studs-up layers have no mid-air start (islandMm2 = 0). Each needs a new audit.
