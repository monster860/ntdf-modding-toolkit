# ntdf-modding-toolkit

This is a library for reading and writing game data from Neopets: The Darkest Faerie. For a GUI frontend to this library, see [ntdf-editor](https://github.com/monster860/ntdf-editor). It currently supports reading and writing of 3D models, collision data, lighting data, dialogue tables, materials, and image data.

[Documentation](https://monster860.github.io/ntdf-modding-toolkit/)

## Blobs

This library relies on JS's Blob objects. While these are supported in most browsers, if you are using node.js, you must use a library like [fetch-blob](https://www.npmjs.com/package/fetch-blob) to ponyfill blobs. Make sure you use version 3.1.4 or later, as earlier versions have a bug with the slice implementation. 

## Example

```js
import { fileFromSync } from 'fetch-blob/from.js';
import { Gamefile, ChunkType, MaterialsChunk } from 'ntdf-modding-toolkit';
import { createWriteStream } from 'fs';

let iso_blob = fileFromSync("./darkestfaerie.iso");
Gamefile.from_iso(iso_blob).then(async gamefile => {
	// Read file 0x38D (which is Ellis Family Farm)
	let ellis_farm = await gamefile.get_chunk_file(0x38D);
	// Read the materials
	let materials = await MaterialsChunk.from_blob(ellis_farm.get_chunk_of_type(ChunkType.Materials).contents);
	// Make the grass materials scroll once per second
	materials.materials[1].passes[0].scroll_rate_x = 1/60;
	materials.materials[6].passes[0].scroll_rate_x = 1/60;
	materials.materials[8].passes[0].scroll_rate_x = 1/60;
	// Write them back to the file
	ellis_farm.get_chunk_of_type(ChunkType.Materials).contents = materials.to_blob();
	// Write the file back to the gamefile
	gamefile.replace_chunk_file(0x38D, ellis_farm);
	// Create a modified .iso file
	let modified_iso_blob = gamefile.patch_iso(iso_blob);
	// Save the modified .iso file
	const output_filename = './darkestfaerie-modified.iso';
	Readable.from(modified_iso.stream()).pipe(createWriteStream(output_filename))
});

```