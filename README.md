# Set2Print

Turn a brick set's parts list into ready-to-print 3MF plates, one batch per colour.

**Use it:** https://smeef123.github.io/set2print/

- Enter a set number with your own free Rebrickable API key, or paste/upload a parts list (`part, colour, quantity`; Rebrickable CSV exports work as they are).
- Every part is fetched from the LDraw parts library, converted to millimetres, turned studs-up, and laid out on plates per colour (Bambu X1/P1 corner no-print zone avoided).
- You download a ZIP: one 3MF per plate plus one STL per unique part, and a list of anything not found.
- Everything runs in your browser. Nothing is uploaded.

Print with slicer supports off; add breakaway fins where a part needs support with [Support Fins](https://printfins.com).

## Credits

- Part geometry: [LDraw.org](https://www.ldraw.org) parts library, CC BY 2.0, by its many authors (served from [gkjohnson/ldraw-parts-library](https://github.com/gkjohnson/ldraw-parts-library)).
- Set inventories and colours: [Rebrickable](https://rebrickable.com).
- Loader: [three.js](https://threejs.org) LDrawLoader. Zip: JSZip.

LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this project. For personal use.

## License

MIT for this code. Part geometry keeps its own CC BY 2.0 licence.
