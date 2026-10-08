/**
 * dsh-geometry-draw — 自由几何绘图插件（Host 半）。
 *
 * 注册一个模型可直接调用的工具 `geometry_draw`：把结构化几何规格编译成
 * 自包含 SVG，并用本机已有的 resvg 栅格化为 PNG，写进会话工作区。
 *
 * 设计原则与 math 插件保持一致：不重造栅格化器；路径、填充规则、渐变、
 * 布尔运算都在自己的几何内核里算清楚，输出的是标准 SVG。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { compileSpec, isSafeColor } from './src/compiler.js';
import { auditFigure } from './src/validate.js';

export const name = 'geometry-draw';
export const inject = ['tools'];

const TOOL_NAME = 'geometry_draw';
const MAX_SPEC_BYTES = 512 * 1024;

const DEFAULTS = {
	outputDir: 'geometry',
	scale: 2,
	background: 'transparent',
	padding: 16,
	preview: false,
};

// ---------------------------------------------------------------- 配置

function fail(message) {
	throw new Error(`geometry-draw config: ${message}`);
}

function readInteger(value, key, min, max) {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value)) fail(`"${key}" must be an integer`);
	if (value < min || value > max) fail(`"${key}" must be between ${min} and ${max}`);
	return value;
}

function readString(value, key) {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || value.trim().length === 0) fail(`"${key}" must be a non-empty string`);
	return value.trim();
}

export function resolveConfig(input) {
	if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) {
		fail('expected an object');
	}
	const raw = input ?? {};
	const outputDir = readString(raw.outputDir, 'outputDir') ?? DEFAULTS.outputDir;
	if (outputDir.startsWith('/') || outputDir.includes('..')) fail('"outputDir" must be workspace-relative without ".."');
	const background = readString(raw.background, 'background') ?? DEFAULTS.background;
	if (background !== 'transparent' && !isSafeColor(background)) fail('"background" must be "transparent" or a flat color');
	return {
		outputDir,
		scale: readInteger(raw.scale, 'scale', 1, 16) ?? DEFAULTS.scale,
		background,
		padding: readInteger(raw.padding, 'padding', 0, 128) ?? DEFAULTS.padding,
		preview: raw.preview === true,
		workspaceRoot: readString(raw.workspaceRoot, 'workspaceRoot'),
	};
}

// ---------------------------------------------------------------- 栅格化

let resvgModule;
let resvgError;

/**
 * 惰性加载 resvg。
 *
 * 为什么不用普通的 `import '@resvg/resvg-js'`：本插件以 `file:` 依赖安装时，
 * pnpm 把它软链到 profile 的 node_modules，而 Node 会按**真实路径**做模块解析
 * ——真实路径是插件源码目录，那里没有 resvg。所以这里显式地从几个候选位置
 * 解析：先按常规解析（插件自带依赖或 hoisted 依赖），再从当前 profile 的
 * node_modules 解析（resvg 随 math 插件一起装在那里，本机已实测可用）。
 */
function loadResvg() {
	if (resvgModule !== undefined) return resvgModule;
	if (resvgError !== undefined) return undefined;
	const candidates = [import.meta.url];
	const profileDir = process.env.DSH_PROFILE_DIR;
	if (typeof profileDir === 'string' && profileDir.length > 0) {
		candidates.push(pathToFileUrl(path.join(profileDir, 'node_modules')));
	}
	if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0) {
		candidates.push(pathToFileUrl(path.join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules')));
		candidates.push(pathToFileUrl(path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'node_modules')));
	}
	for (const base of candidates) {
		try {
			const require = createRequire(base);
			resvgModule = require('@resvg/resvg-js');
			return resvgModule;
		} catch {
			// 换下一个候选位置
		}
	}
	resvgError = new Error('@resvg/resvg-js is not resolvable from this installation');
	return undefined;
}

function pathToFileUrl(directory) {
	const normalized = directory.replaceAll('\\', '/');
	return `file:///${normalized.replace(/^\/+/, '')}/`;
}

export function rasterize(svg, width, scale) {
	const module = loadResvg();
	if (module === undefined) return undefined;
	const renderer = new module.Resvg(svg, {
		fitTo: { mode: 'zoom', value: scale },
		font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
	});
	const rendered = renderer.render();
	return { data: rendered.asPng(), width: rendered.width, height: rendered.height };
}

// ---------------------------------------------------------------- 工作区写入

function contentHash(parts) {
	const hash = createHash('sha256');
	for (const part of parts) {
		hash.update(part);
		hash.update('\0');
	}
	return hash.digest('hex').slice(0, 12);
}

function safeBaseName(value, fallback) {
	if (value === undefined) return fallback;
	const cleaned = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[.-]+/, '')
		.replace(/[.-]+$/, '')
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : fallback;
}

function isInside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveInsideWorkspace(root, requested) {
	const absolute = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested);
	if (absolute === path.resolve(root) || !isInside(path.resolve(root), absolute)) {
		throw new Error(`"${requested}" is outside the session workspace (${root})`);
	}
	const realRoot = await realpath(root).catch(() => path.resolve(root));
	let existing = absolute;
	while (!existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
	const realExisting = await realpath(existing).catch(() => existing);
	if (!isInside(realRoot, realExisting) && realExisting !== realRoot) {
		throw new Error(`"${requested}" resolves outside the session workspace through a symbolic link`);
	}
	return absolute;
}

function toRelative(root, hostPath) {
	return path.relative(root, hostPath).split(path.sep).join('/');
}

async function planTarget(root, outputDir, requested, baseName, extension) {
	const relative =
		requested === undefined
			? path.join(outputDir, `${baseName}${extension}`)
			: /\.(?:svg|png)$/i.test(requested)
				? requested
				: path.join(requested, `${baseName}${extension}`);
	const hostPath = await resolveInsideWorkspace(root, relative);
	return { hostPath, relativePath: toRelative(root, hostPath) };
}

let temporaryCounter = 0;
async function writeOutput(target, data) {
	await mkdir(path.dirname(target.hostPath), { recursive: true });
	temporaryCounter += 1;
	const temporary = `${target.hostPath}.${process.pid}.${temporaryCounter}.tmp`;
	await writeFile(temporary, data);
	await rename(temporary, target.hostPath);
	return typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
}

function resolveWorkspaceRoot(config, exec) {
	if (config.workspaceRoot !== undefined) return path.resolve(config.workspaceRoot);
	const fromSession = exec?.agent?.session?.header?.cwd;
	if (typeof fromSession === 'string' && fromSession.length > 0) return path.resolve(fromSession);
	return process.cwd();
}

// ---------------------------------------------------------------- 参数校验

const SPEC_HELP = [	'Spec shape: {width?, height?, padding?, background?, xRange?, yRange?, vars?, shapes?, grid?, axes?, title?, elements:[…]}.',
	'Coordinates are mathematical (x right, y up). Elements: rect, circle, ellipse, polygon, polyline, star, path (raw SVG "d"), point, text, segment, line, ray, vector, arrow, angle, dimension, group, curve (y=f(x)), parametric (x,y in t), polar (r in theta), and boolean/offset shapes.',
	'Every element accepts transform ({rotate, scale, translate, about, mirror} or an SVG transform string), fill/stroke style, offset (contour offset, +grow/−shrink), boolean (union|intersect|difference|xor with nested elements), repeat (rotational array), and mirror.',
	'Fills accept a color or {type:"linear"|"radial", stops:[{offset,color}], from/to|center/radius} or {type:"pattern", tile, shapes:[…]}.',
	'Style keys: fill, stroke, stroke_width, stroke_dasharray, fill_opacity, stroke_opacity, opacity, fill_rule. Expressions are allowed anywhere a number is: implicit multiplication (2x, 3sin(t)), pi/tau/e/phi, and the usual sin/cos/tan/sqrt/abs/ln/exp/floor/min/max/pow family, plus any name declared in vars.',
	'Labels on points/shapes and text elements are drawn as real text; label_offset (on points) is in screen pixels, y down.',
].join('\n');

const COOKBOOK = [
	'Recipes:',
	'• Region with holes → {type:"boolean", boolean:"difference", elements:[outer, …holes]}. Never fake a hole with a white shape on top.',
	'• Ring/band → same shape twice, one with a positive offset and one negative, subtracted.',
	'• Snowflake/ornament → draw ONE arm, then repeat:{count:6, mirror_each:true}.',
	'• Rose window → circle minus n evenly-placed circles (a repeated circle), then a star on top.',
	'• Annotated construction → polygon + point labels + angle (right:true for the square mark) + dimension.',
	'Pitfalls: multi-contour shapes are read by the even-odd rule, so a hole only appears if the contours truly nest — if a hole gets filled in, declare fill_rule:"evenodd" explicitly. A shape whose offset shrinks past its inradius legitimately disappears (reported as a warning). Curves break at poles/domain gaps instead of drawing a false vertical line. Read the returned warnings: they flag degenerate contours, self-intersections and fill-rule hazards that a thumbnail cannot show.',
].join('\n');

function readCommonArgs(raw) {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${TOOL_NAME}: arguments must be an object`);
	const allowed = new Set(['figure', 'format', 'scale', 'background', 'padding', 'path', 'name', 'preview', 'audit', 'data_uri']);
	for (const key of Object.keys(raw)) {
		if (!allowed.has(key)) {
			throw new Error(`${TOOL_NAME}: unknown argument "${key}" (supported: ${[...allowed].join(', ')})`);
		}
	}
	return raw;
}

function checkSpecSize(spec) {
	let text;
	try {
		text = JSON.stringify(spec);
	} catch {
		throw new Error(`${TOOL_NAME}: "figure" contains values that cannot be serialized`);
	}
	if (text === undefined) throw new Error(`${TOOL_NAME}: "figure" must be serializable`);
	if (text.length > MAX_SPEC_BYTES) {
		throw new Error(`${TOOL_NAME}: "figure" is ${(text.length / 1024).toFixed(0)}KB, over the ${MAX_SPEC_BYTES / 1024}KB limit`);
	}
}

function formatValue(value) {
	const lines = [];
	lines.push(`SVG: ${value.svgPath !== undefined && value.svgPath !== '' ? value.svgPath : '(not written)'}`);
	if (value.pngPath !== undefined && value.pngPath !== '') {
		lines.push(`PNG: ${value.pngPath} (${value.pngWidth}×${value.pngHeight})`);
	} else if (value.pngNote !== undefined && value.pngNote !== '') {
		lines.push(`PNG: unavailable — ${value.pngNote}`);
	}
	lines.push(`Canvas: ${value.width}×${value.height}`);
	if (value.stats !== undefined) {
		lines.push(
			`Geometry: ${value.stats.rings} contours, ${value.stats.points} points, ${value.stats.elements} elements` +
				(value.stats.selfIntersections > 0 ? `, ${value.stats.selfIntersections} self-intersections` : ''),
		);
	}
	if (Array.isArray(value.warnings) && value.warnings.length > 0) {
		lines.push('Warnings:');
		for (const warning of value.warnings) lines.push(`  - ${warning}`);
	}
	if (value.markdown !== undefined) lines.push(`\nEmbed: ${value.markdown}`);
	if (value.html !== undefined) lines.push(`HTML: ${value.html}`);
	return lines.join('\n');
}
// ---------------------------------------------------------------- 工具定义

export function createGeometryTool(ctx, config) {
	return {
		name: TOOL_NAME,
		description:
			'Draw arbitrary geometric figures — constructions, filled regions, boolean combinations, patterns, symmetric ornaments — as a self-contained SVG plus a PNG raster, written into the session workspace. ' +
			'Figures are declared as a JSON spec in mathematical coordinates, not coded. ' +
			'Use it whenever the deliverable is a drawing: complex filled shapes, rings with holes, difference/intersection of regions, outlined or offset contours, rotated arrays, gradients and pattern fills, parametric curves, or annotated geometry (vertices, angle arcs, right-angle marks, dimensions).\n\n' +
			SPEC_HELP +
			'\n\n' +
			COOKBOOK,
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['figure'],
			properties: {
				figure: {
					type: 'object',
					description:
						'Geometry spec. Coordinates are mathematical (y up). Top level: width/height/padding/background/xRange/yRange/vars/shapes/title/elements. ' +
						'Boolean regions: {type:"boolean", boolean:"difference"|"union"|"intersect"|"xor", elements:[…]}. ' +
						'Contour offset: any shape accepts "offset" (positive grows, negative shrinks). ' +
						'Rotational array: "repeat":{count, rotate, about:[x,y], shrink, mirror_each}. ' +
						'Mirroring: "mirror":{axis:"x"|"y"|angle, through:[x,y]}.',
				},
				format: {
					type: 'string',
					enum: ['svg', 'png', 'both'],
					default: 'both',
					description: 'Which artifacts to write. "svg" needs no rasterizer.',
				},
				scale: {
					type: 'number',
					default: DEFAULTS.scale,
					description: `PNG zoom factor (default ${DEFAULTS.scale}): pixel size = canvas size × scale.`,
				},
				background: {
					type: 'string',
					default: DEFAULTS.background,
					description: '"transparent" or a flat CSS color; a "background" inside the spec wins.',
				},
				padding: {
					type: 'integer',
					default: DEFAULTS.padding,
					description: `Transparent margin in pixels (default ${DEFAULTS.padding}); a "padding" inside the spec wins.`,
				},
				path: {
					type: 'string',
					description: 'Workspace-relative output file (.svg/.png) or directory. Defaults to the configured output directory.',
				},
				name: {
					type: 'string',
					description: 'Readable file base name; sanitized to [A-Za-z0-9._-]. Defaults to a content hash.',
				},
				preview: {
					type: 'boolean',
					default: false,
					description: 'Attach the rendered PNG to this result when the active model accepts image input.',
				},
				audit: {
					type: 'boolean',
					default: true,
					description: 'Run the structural self-check and report degenerate contours, self-intersections and fill-rule hazards as warnings.',
				},
				data_uri: {
					type: 'boolean',
					default: false,
					description: 'Also return the PNG as a base64 data URI, for embedding where a sibling file cannot be referenced.',
				},
			},
		},
		output: {
			// 注意：DSH 的工具输出 schema 是 **单类型** 的，不接受 `type: ["string","null"]`
			// 这种类型数组（会在注册时抛 JsonSchemaError 并让整个插件激活失败）。
			// 因此可选字段用「空字符串 / 0」表示「无」，而不是 null。
			schema: {
				type: 'object',
				additionalProperties: true,
				properties: {
					svgPath: { type: 'string', description: '工作区相对的 SVG 路径；未写出时为空字符串。' },
					pngPath: { type: 'string', description: '工作区相对的 PNG 路径；未写出时为空字符串。' },
					pngWidth: { type: 'integer', description: 'PNG 像素宽；未出 PNG 时为 0。' },
					pngHeight: { type: 'integer', description: 'PNG 像素高；未出 PNG 时为 0。' },
					pngNote: { type: 'string', description: '栅格化不可用时的说明，否则为空。' },
					width: { type: 'integer' },
					height: { type: 'integer' },
					markdown: { type: 'string' },
					html: { type: 'string' },
					latex: { type: 'string' },
					dataUri: { type: 'string', description: 'PNG 的 base64 data URI；未请求时为空。' },
					warnings: { type: 'array', items: { type: 'string' } },
					stats: { type: 'object' },
				},
			},
			render(_args, value) {
				return [{ type: 'text', text: formatValue(value) }];
			},
		},
		async execute(rawArgs, exec) {
			const args = readCommonArgs(rawArgs);
			const spec = args.figure;
			if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
				throw new Error(`${TOOL_NAME}: "figure" must be an object`);
			}
			checkSpecSize(spec);

			const format = args.format ?? 'both';
			if (!['svg', 'png', 'both'].includes(format)) {
				throw new Error(`${TOOL_NAME}: "format" must be svg, png or both`);
			}
			const scale = args.scale === undefined ? config.scale : args.scale;
			if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.25 || scale > 16) {
				throw new Error(`${TOOL_NAME}: "scale" must be a number between 0.25 and 16`);
			}
			const background = args.background ?? (spec.background !== undefined ? spec.background : config.background);
			if (background !== 'transparent' && !isSafeColor(background)) {
				throw new Error(`${TOOL_NAME}: "background" must be "transparent" or a flat color`);
			}
			const padding = args.padding ?? config.padding;

			const compiled = compileSpec(spec, { background, padding });
			const audit = args.audit === false
				? { warnings: [], stats: {} }
				: auditFigure({ spec, compiled: compiled.elements ?? [], range: compiled.range, canvas: compiled, svg: compiled.svg });

			const warnings = [...compiled.warnings, ...audit.warnings];
			const root = resolveWorkspaceRoot(config, exec);
			const baseName = safeBaseName(args.name, `figure-${contentHash([compiled.svg, String(compiled.width), String(compiled.height)])}`);

			let svgPath;
			let pngPath;
			let pngWidth;
			let pngHeight;
			let pngNote;
			let dataUri;

			if (format === 'svg' || format === 'both') {
				const target = await planTarget(root, config.outputDir, args.path, baseName, '.svg');
				await writeOutput(target, compiled.svg);
				svgPath = target.relativePath;
			}
			if (format === 'png' || format === 'both') {
				const raster = rasterize(compiled.svg, compiled.width, scale);
				if (raster === undefined) {
					pngNote = 'the local rasterizer (@resvg/resvg-js) is unavailable; the SVG was still written';
					warnings.push(pngNote);
					if (format === 'png') {
						const target = await planTarget(root, config.outputDir, args.path, baseName, '.svg');
						await writeOutput(target, compiled.svg);
						svgPath = target.relativePath;
					}
				} else {
					const target = await planTarget(root, config.outputDir, args.path, baseName, '.png');
					await writeOutput(target, raster.data);
					pngPath = target.relativePath;
					pngWidth = raster.width;
					pngHeight = raster.height;
					if (args.data_uri === true || config.dataUri === true) {
						dataUri = `data:image/png;base64,${Buffer.from(raster.data).toString('base64')}`;
					}
				}
			}

			const embedTarget = pngPath ?? svgPath;
			const value = {
				svgPath: svgPath ?? '',
				pngPath: pngPath ?? '',
				pngWidth: pngWidth ?? 0,
				pngHeight: pngHeight ?? 0,
				pngNote: pngNote ?? '',
				width: compiled.width,
				height: compiled.height,
				markdown: `![geometry](${embedTarget})`,
				html: `<img src="${embedTarget}" width="${pngWidth ?? compiled.width}" height="${pngHeight ?? compiled.height}" alt="geometry">`,
				latex: `\\includegraphics[width=${((pngWidth ?? compiled.width) / 96 * 2.54).toFixed(2)}cm]{${embedTarget}}`,
				dataUri: dataUri ?? '',
				warnings,
				stats: {
					...audit.stats,
					elements: compiled.stats.elements,
					rendered: compiled.stats.rendered,
					scale,
					canvas: { width: compiled.width, height: compiled.height },
					range: compiled.range,
				},
			};
			void ctx;
			return value;
		},
	};
}

export function apply(ctx, config) {
	const resolved = resolveConfig(config);
	ctx.tools.register(createGeometryTool(ctx, resolved));
	// 系统提示词是可选的：没有该服务的组合照样能拿到工具，只是少一句使用指引。
	if (typeof ctx.inject === 'function') {
		ctx.inject(['systemPrompt'], (promptCtx) => {
			registerGeometryPromptSection(promptCtx);
		});
	} else if (ctx.systemPrompt !== undefined) {
		registerGeometryPromptSection(ctx);
	}
	// 随包出货的技能树：只挂载本包的 skills/，不动宿主默认的技能根目录。
	if (typeof ctx.inject === 'function') {
		ctx.inject(['skills', 'agents'], (skillCtx) => {
			void mountBundledSkills(skillCtx);
		});
	} else if (ctx.skills !== undefined) {
		void mountBundledSkills(ctx);
	}
	// 可选：注册一个专职绘图 Agent 预设，让会话能直接切到「只带绘图工具」的组合。
	if (typeof ctx.inject === 'function') {
		ctx.inject(['agentPresets'], (presetCtx) => {
			void registerDrawingPreset(presetCtx);
		});
	}
}

const SKILL_PROVIDER = 'dsh-geometry-draw';
let skillProviderApplied = false;

/**
 * 挂载随包的 skills/。
 *
 * `@deepseek-ai/dsh-skill-filesystem` 随 harness 出货，但它不在 profile 的
 * node_modules 里，能否解析取决于宿主的模块布局（打包成 app.asar 时通常解析
 * 不到）。因此这里**允许失败**：拿不到技能文件系统时，工具本身照样可用，
 * 构图要点也已经内联在工具描述里，agent 不会因此变瞎。
 */
export async function mountBundledSkills(ctx) {
	if (skillProviderApplied) return;
	for (const specifier of skillFilesystemCandidates()) {
		try {
			const module = await import(specifier);
			if (typeof module.apply !== 'function') continue;
			const skillsRoot = fileURLToPath(new URL('./skills/', import.meta.url));
			module.apply(ctx, {
				providerName: SKILL_PROVIDER,
				includeDefaultRoots: false,
				bundledSkillDir: skillsRoot,
				watch: false,
			});
			skillProviderApplied = true;
			return;
		} catch {
			// 换下一个候选路径
		}
	}
}

/**
 * `@deepseek-ai/dsh-skill-filesystem` 的候选解析位置。
 *
 * 它随 harness 出货，因此可能只存在于 dsh 的安装目录（打包形态下就在 app.asar
 * 里的 node_modules），而不在 profile 的 node_modules 中。这里按「从最可能到最
 * 兜底」列出候选：包名直连 → dsh 安装目录的 node_modules → app.asar 内的具体
 * 路径。任何一步失败都只是拿不到技能树（工具本身不受影响）。
 */
function skillFilesystemCandidates() {
	const candidates = ['@deepseek-ai/dsh-skill-filesystem'];
	const dshRoot = dshInstallRoot();
	if (dshRoot !== undefined) {
		const modulesDir = `${dshRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/node_modules`;
		candidates.push(`file:///${modulesDir.replace(/^\/+/, '')}/@deepseek-ai/dsh-skill-filesystem/lib/index.js`);
		candidates.push(`file:///${modulesDir.replace(/^\/+/, '')}/@deepseek-ai/dsh-skill-filesystem/index.js`);
	}
	return candidates;
}

/** 推导 dsh 的安装根目录（打包形态下是 …/resources/app.asar/dsh） */
function dshInstallRoot() {
	const resources = process.resourcesPath;
	if (typeof resources === 'string' && resources.length > 0) {
		return `${resources}\\app.asar\\dsh`;
	}
	const execPath = process.execPath;
	if (typeof execPath === 'string' && execPath.length > 0) {
		return `${path.dirname(execPath)}\\resources\\app.asar\\dsh`;
	}
	return undefined;
}

/**
 * 注册专职绘图 Agent 预设。
 *
 * 预设的 `plugins` 只声明**额外交付**给这个 Agent 的东西（本插件的工具与技能）；
 * 会话的工具基线由预设所在的那一层提供，因此这里不需要（也不应该）把基础工具
 * 再抄一遍。注册失败只影响「能否切换到专职 agent」，不影响绘图工具本身。
 */
export async function registerDrawingPreset(ctx) {
	if (typeof ctx.agentPresets?.register !== 'function') return;
	try {
		await ctx.agentPresets.register({
			id: 'geometry',
			name: '几何绘图',
			description: '专注自由几何绘图：布尔运算、轮廓偏移、多轮廓填色、渐变与图案、参数曲线、旋转阵列与几何标注。',
			order: 40,
			plugins: [],
		});
	} catch (error) {
		if (typeof ctx.logger?.warn === 'function') {
			ctx.logger.warn(`geometry-draw: agent preset not registered (${error instanceof Error ? error.message : String(error)})`);
		}
	}
}

export const PROMPT_SECTION_NAME = 'geometry-draw-tools';

/**
 * 系统提示词里的一句话指引：只在工具可见时出现。
 * 指引里明确「不要自己写 SVG」——否则模型很容易绕过工具手工拼字符串，
 * 丢掉布尔运算、填充规则与自检带来的正确性。
 */
export function geometryToolGuidance() {
	return (
		'Geometry drawing: when the deliverable is a drawing — a filled complex shape, a region with holes, ' +
		'a boolean combination of shapes, an outlined/offset contour, a symmetric ornament, a pattern or gradient fill, ' +
		'a parametric curve, or an annotated construction — call `geometry_draw` with a declarative spec instead of ' +
		'hand-writing SVG or a plotting script. The spec is in mathematical coordinates (y up), supports boolean ops ' +
		'(union/intersect/difference/xor), contour offset, rotational arrays and mirroring; every call writes an SVG ' +
		'plus a PNG into the session workspace and returns ready-to-embed Markdown/HTML/LaTeX snippets. ' +
		'Read the returned warnings: they report degenerate contours, self-intersections and fill-rule hazards that are ' +
		'invisible in a thumbnail. To check the result yourself, pass `preview: true` so the PNG comes back with the call.'
	);
}

export function registerGeometryPromptSection(ctx) {
	ctx.systemPrompt.section({
		name: PROMPT_SECTION_NAME,
		order: 150,
		text: () => geometryToolGuidance(),
	});
}
