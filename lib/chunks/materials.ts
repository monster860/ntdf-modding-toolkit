import { GsAlphaFailMethod, GsAlphaParam, GsAlphaTestMethod, GsColorParam, GsDepthTestMethod, GsFilter, GsRegister, GsStorageFormat, GsWrapMode } from "../ps2/gs_constants.js";
import Blob from "cross-blob";
import { extract_bits, insert_bits } from "../utils/misc.js";
import assert from "assert";

export class MaterialPass {
	shader_type : ShaderType = ShaderType.Unlit;
	scroll_rate_x = 0;
	scroll_rate_y = 0;
	texture_log_width = 0;
	texture_log_height = 0;
	texture_location : number[] = [];
	texture_buffer_width = 4;
	texture_format = GsStorageFormat.PSMCT32;
	clut_location = 0;

	mag_filter : GsFilter = GsFilter.LINEAR;
	min_filter : GsFilter = GsFilter.LINEAR_MIPMAP_NEAREST;
	fixed_mipmap = true;
	mipmap_l = 0;
	mipmap_k = -0.0625;

	wrap_h = GsWrapMode.REPEAT;
	wrap_v = GsWrapMode.REPEAT;
	wrap_params : [number,number,number,number] = [0,0,0,0];

	alpha_test_on = true;
	alpha_test_method = GsAlphaTestMethod.GEQUAL;
	alpha_test_ref = 120/128;
	alpha_fail_method = GsAlphaFailMethod.FB_ONLY;

	dest_alpha_test_on = false;
	dest_alpha_test_value = 0;

	depth_test_on = true;
	depth_test_method = GsDepthTestMethod.GEQUAL;

	alpha_blend_a = GsColorParam.RgbSource;
	alpha_blend_b = GsColorParam.RgbDest;
	alpha_blend_c = GsAlphaParam.AlphaSource;
	alpha_blend_d = GsColorParam.RgbDest;
	alpha_blend_value = 0;

	metallic = false;

	animated = false;
	animate_num_frames = 0;
	animate_num_frames_x = 0;
	animate_num_frames_y = 0;
	animate_frame_delay = 0;
}

export class Material {
	texture_file = -1;
	passes : MaterialPass[] = [];
}

export enum ShaderType {
	Unlit = 0,
	Lit = 1,
	LitRigged = 2,
	UnlitNormals = 4,
	SpecularRigged = 6,
}

export class MaterialsChunk {
	constructor(public materials : Material[], public num_texture_files : number) {

	}

	static async from_blob(blob : Blob) {
		let data = new Uint8Array(await blob.arrayBuffer());
		let dv = new DataView(data.buffer);

		let materials : Material[] = [];
		let num_texture_files = dv.getUint32(0x1c, true);
		let num_materials = dv.getUint32(0x14, true);
		let materials_list_ptr = dv.getUint32(0x10, true);

		for(let i = 0; i < num_materials; i++) {
			let material_ptr = materials_list_ptr + 0x270*i;
			let material = new Material();
			material.texture_file = dv.getInt8(material_ptr + 0x28);
			for(let j = 0; j < 2; j++) {
				let pass_shader = dv.getInt16(material_ptr + 0x44 + 0x10*j, true);
				if(pass_shader >= 0) {
					let pass = new MaterialPass();
					pass.shader_type = pass_shader;
					let effect = dv.getInt16(material_ptr + 0x4c + 0x10*j, true);
					if(effect == 2) {
						pass.scroll_rate_x = dv.getFloat32(material_ptr + 0x60 + 0x10*j, true);
						pass.scroll_rate_y = dv.getFloat32(material_ptr + 0x64 + 0x10*j, true);
					}
					pass.metallic = effect == 1;
					pass.animated = effect == 3;
					pass.animate_num_frames = dv.getFloat32(material_ptr + 0x0 + 0x10*j, true);
					pass.animate_num_frames_x = dv.getFloat32(material_ptr + 0x4 + 0x10*j, true);
					pass.animate_num_frames_y = dv.getFloat32(material_ptr + 0x8 + 0x10*j, true);
					pass.animate_frame_delay = dv.getFloat32(material_ptr + 0xC + 0x10*j, true);
					material.passes.push(pass);
				} else {
					break;
				}
			}
			

			let num_gs_registers = data[0xd0+material_ptr];
			for(let j = 0; j < num_gs_registers; j++) {
				let register_ptr = material_ptr + 0xe0 + j*0x10;
				let register_id = data[register_ptr+0x8];
				let pass = material.passes[0];
				// In case your confused about context 2 vs context 1:
				// the game uses context 2 for the first pass
				// and context 1 for the second pass, so that's why its backwards
				switch(register_id) {
					case GsRegister.TEX0_1:
						pass = material.passes[1];
					case GsRegister.TEX0_2:
						pass.texture_location[0] = extract_bits(data, register_ptr, 0, 14);
						pass.texture_format = extract_bits(data, register_ptr, 20, 6);
						pass.texture_buffer_width = extract_bits(data, register_ptr, 14, 6);
						pass.texture_log_width = extract_bits(data, register_ptr, 26, 4);
						pass.texture_log_height = extract_bits(data, register_ptr, 30, 4);

						pass.clut_location = extract_bits(data, register_ptr, 37, 14);
						break;
					case GsRegister.TEX1_1:
						pass = material.passes[1];
					case GsRegister.TEX1_2:
						pass.fixed_mipmap = extract_bits(data, register_ptr, 0, 1) != 0;
						pass.texture_location.length = extract_bits(data, register_ptr, 2, 3)+1;
						pass.mag_filter = extract_bits(data, register_ptr, 5, 1);
						pass.min_filter = extract_bits(data, register_ptr, 6, 3);
						pass.mipmap_l = extract_bits(data, register_ptr, 19, 2);
						pass.mipmap_k = ((extract_bits(data, register_ptr, 32, 12) << 20) >> 20) / 16;
						break;
					case GsRegister.MIPTBP1_1:
						pass = material.passes[1];
					case GsRegister.MIPTBP1_2:
						if(pass.texture_location.length >= 2)
							pass.texture_location[1] = extract_bits(data, register_ptr, 0, 14);
						if(pass.texture_location.length >= 3)
							pass.texture_location[2] = extract_bits(data, register_ptr, 20, 14);
						if(pass.texture_location.length >= 4)
							pass.texture_location[3] = extract_bits(data, register_ptr, 40, 14);
						break;
					case GsRegister.CLAMP_1:
						pass = material.passes[1];
					case GsRegister.CLAMP_2:
						pass.wrap_h = extract_bits(data, register_ptr, 0, 2);
						pass.wrap_v = extract_bits(data, register_ptr, 2, 2);
						pass.wrap_params = [
							extract_bits(data, register_ptr, 4, 10),
							extract_bits(data, register_ptr, 14, 10),
							extract_bits(data, register_ptr, 24, 10),
							extract_bits(data, register_ptr, 34, 10)
						];
						break;
					case GsRegister.ALPHA_1:
						pass = material.passes[1];
					case GsRegister.ALPHA_2:
						pass.alpha_blend_a = extract_bits(data, register_ptr, 0, 2);
						pass.alpha_blend_b = extract_bits(data, register_ptr, 2, 2);
						pass.alpha_blend_c = extract_bits(data, register_ptr, 4, 2);
						pass.alpha_blend_d = extract_bits(data, register_ptr, 6, 2);
						pass.alpha_blend_value = extract_bits(data, register_ptr, 32, 8) / 128;
						break;
					case GsRegister.TEST_1:
						pass = material.passes[1];
					case GsRegister.TEST_2:
						pass.alpha_test_on = extract_bits(data, register_ptr, 0, 1) != 0;
						pass.alpha_test_method = extract_bits(data, register_ptr, 1, 3);
						pass.alpha_test_ref = extract_bits(data, register_ptr, 4, 8) / 128;
						pass.alpha_fail_method = extract_bits(data, register_ptr, 12, 2);
						pass.dest_alpha_test_on = extract_bits(data, register_ptr, 14, 1) != 0;
						pass.dest_alpha_test_value = extract_bits(data, register_ptr, 15, 1);
						pass.depth_test_on = extract_bits(data, register_ptr, 16, 1) != 0;
						pass.depth_test_method = extract_bits(data, register_ptr, 17, 2);
						break;
				}
			}
			materials.push(material);
		}
		return new MaterialsChunk(materials, num_texture_files);
	}

	to_blob() : Blob {
		let dv = new DataView(new ArrayBuffer(0x20 + 0x270*this.materials.length + 0x4*this.num_texture_files));
		let data = new Uint8Array(dv.buffer);

		dv.setUint32(0x10, 0x20, true);
		dv.setUint32(0x14, this.materials.length, true);
		dv.setUint32(0x18, 0x20+0x270*this.materials.length, true); // This is a pointer to an array that the game populates with pointers to the texture files.
		dv.setUint32(0x1c, this.num_texture_files, true);

		for(let i = 0; i < this.materials.length; i++) {
			let mat_ptr = i*0x270 + 0x20;
			let material = this.materials[i];
			assert(material.passes.length == 1 || material.passes.length == 2, "Material must have exactly 1 or 2 passes, but material " + i + " has " + material.passes.length);

			dv.setUint16(mat_ptr+0x20, i, true);
			dv.setUint16(mat_ptr+0x22, material.passes[0].texture_location[0], true);
			dv.setUint16(mat_ptr+0x26, material.texture_file >= 0 ? material.passes.length : 0, true);
			dv.setInt8(mat_ptr+0x28, material.texture_file);
			if(material.passes[0].animated || material.passes[1]?.animated) {
				dv.setInt8(mat_ptr+0x2B, 1);
			}

			for(let j = 0; j < 2; j++) {
				let info_ptr = mat_ptr + 0x30 + 0x50*j;
				let gif_ptr = mat_ptr + 0xD0 + 0xD0*j;

				data[info_ptr + 2] = 5;
				data[info_ptr + 4] = 5;
				data[info_ptr + 5] = 3;

				data[gif_ptr] = material.passes.length * 6;
				data[gif_ptr+1] = 0x80;
				data[gif_ptr+2] = material.passes.length * 6 + 1;
				data[gif_ptr+4] = material.passes.length * 6 + 1;
				data[gif_ptr+5] = 1;
				data[gif_ptr+7] = 0x10;
				data[gif_ptr+8] = 0xe;
				gif_ptr += 0x10;

				for(let k = 0; k < 2; k++) {
					if(k >= material.passes.length) {
						dv.setInt16(info_ptr + 0x14 + 0x10*k, -1, true);
						continue;
					}
					let pass = material.passes[k];
					dv.setInt16(info_ptr + 0x10 + 0x10*k, k + material.passes.length, true);
					dv.setInt16(info_ptr + 0x14 + 0x10*k, pass.shader_type, true);
					if(pass.shader_type === ShaderType.Unlit)
						dv.setInt16(info_ptr + 0x18 + 0x10*k, 0x23, true);
					else if(pass.shader_type === ShaderType.LitRigged)
						dv.setInt16(info_ptr + 0x18 + 0x10*k, 0x3b, true);
					else if(pass.shader_type === ShaderType.SpecularRigged)
						dv.setInt16(info_ptr + 0x18 + 0x10*k, 0x3f, true);
					else
						dv.setInt16(info_ptr + 0x18 + 0x10*k, 0x27, true);
					if(pass.animated)
						dv.setInt16(info_ptr + 0x1C + 0x10*k, 3, true);
					else if(pass.metallic)
						dv.setInt16(info_ptr + 0x1C + 0x10*k, 1, true);
					else if(pass.scroll_rate_x !== 0 || pass.scroll_rate_y !== 0)
						dv.setInt16(info_ptr + 0x1C + 0x10*k, 2, true);

					
					pass.animate_num_frames = dv.getFloat32(mat_ptr + 0x0 + 0x10*j, true);
					pass.animate_num_frames_x = dv.getFloat32(mat_ptr + 0x4 + 0x10*j, true);
					pass.animate_num_frames_y = dv.getFloat32(mat_ptr + 0x8 + 0x10*j, true);
					pass.animate_frame_delay = dv.getFloat32(mat_ptr + 0xC + 0x10*j, true);

					dv.setFloat32(info_ptr + 0x30 + 0x10*k, pass.scroll_rate_x, true);
					dv.setFloat32(info_ptr + 0x34 + 0x10*k, pass.scroll_rate_y, true);

					// the game uses context 2 for the first pass
					// and context 1 for the second pass, so that's why its backwards
					data[gif_ptr+8] = k ? GsRegister.TEX0_1 : GsRegister.TEX0_2;
					insert_bits(data, gif_ptr, 0, 14, pass.texture_location[0] ?? 0);
					insert_bits(data, gif_ptr, 14, 6, pass.texture_buffer_width);
					insert_bits(data, gif_ptr, 20, 6, pass.texture_format);
					insert_bits(data, gif_ptr, 26, 4, pass.texture_log_width);
					insert_bits(data, gif_ptr, 30, 4, pass.texture_log_height);
					insert_bits(data, gif_ptr, 34, 1, 1);
					insert_bits(data, gif_ptr, 51, 4, GsStorageFormat.PSMCT32);
					if(material.texture_file >= 0) insert_bits(data, gif_ptr, 61, 3, 4)
					insert_bits(data, gif_ptr, 37, 14, pass.clut_location);
					gif_ptr += 16;

					data[gif_ptr+8] = k ? GsRegister.TEX1_1 : GsRegister.TEX1_2;
					insert_bits(data, gif_ptr, 0, 1, pass.fixed_mipmap ? 1 : 0);
					insert_bits(data, gif_ptr, 2, 3, pass.texture_location.length - 1);
					insert_bits(data, gif_ptr, 5, 1, pass.mag_filter);
					insert_bits(data, gif_ptr, 6, 3, pass.min_filter);
					insert_bits(data, gif_ptr, 19, 2, pass.mipmap_l);
					insert_bits(data, gif_ptr, 32, 12, (pass.mipmap_k * 16) & 0xFFF);
					gif_ptr += 16;

					data[gif_ptr+8] = k ? GsRegister.MIPTBP1_1 : GsRegister.MIPTBP1_2;
					if(pass.texture_location.length >= 1)
						insert_bits(data, gif_ptr, 0, 14, pass.texture_location[1]);
					if(pass.texture_location.length >= 2)
						insert_bits(data, gif_ptr, 20, 14, pass.texture_location[2]);
					if(pass.texture_location.length >= 3)
						insert_bits(data, gif_ptr, 40, 14, pass.texture_location[3]);
					insert_bits(data, gif_ptr, 14, 6, pass.texture_buffer_width);
					insert_bits(data, gif_ptr, 34, 6, pass.texture_buffer_width);
					insert_bits(data, gif_ptr, 54, 6, pass.texture_buffer_width);
					gif_ptr += 16;

					data[gif_ptr+8] = k ? GsRegister.CLAMP_1 : GsRegister.CLAMP_2;
					insert_bits(data, gif_ptr, 0, 2, pass.wrap_h);
					insert_bits(data, gif_ptr, 2, 2, pass.wrap_v);
					insert_bits(data, gif_ptr, 4, 10, pass.wrap_params[0]);
					insert_bits(data, gif_ptr, 14, 10, pass.wrap_params[1]);
					insert_bits(data, gif_ptr, 24, 10, pass.wrap_params[2]);
					insert_bits(data, gif_ptr, 34, 10, pass.wrap_params[3]);
					gif_ptr += 16;

					data[gif_ptr+8] = k ? GsRegister.ALPHA_1 : GsRegister.ALPHA_2;
					insert_bits(data, gif_ptr, 0, 2, pass.alpha_blend_a);
					insert_bits(data, gif_ptr, 2, 2, pass.alpha_blend_b);
					insert_bits(data, gif_ptr, 4, 2, pass.alpha_blend_c);
					insert_bits(data, gif_ptr, 6, 2, pass.alpha_blend_d);
					insert_bits(data, gif_ptr, 32, 8, Math.max(0, Math.min(255, Math.round(pass.alpha_blend_value * 128))));
					gif_ptr += 16;

					data[gif_ptr+8] = k ? GsRegister.TEST_1 : GsRegister.TEST_2;
					insert_bits(data, gif_ptr, 0, 1, pass.alpha_test_on ? 1 : 0);
					insert_bits(data, gif_ptr, 1, 3, pass.alpha_test_method);
					insert_bits(data, gif_ptr, 4, 8, Math.max(0, Math.min(255, Math.round(pass.alpha_test_ref * 128))));
					insert_bits(data, gif_ptr, 12, 2, pass.alpha_fail_method);
					insert_bits(data, gif_ptr, 14, 1, pass.dest_alpha_test_on ? 1 : 0);
					insert_bits(data, gif_ptr, 15, 1, pass.dest_alpha_test_value);
					insert_bits(data, gif_ptr, 16, 1, pass.depth_test_on ? 1 : 0);
					insert_bits(data, gif_ptr, 17, 2, pass.depth_test_method);
					gif_ptr += 16;
				}
			}
		}

		return new Blob([dv.buffer]);
	}
}
