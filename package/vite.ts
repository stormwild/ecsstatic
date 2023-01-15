import esbuild from 'esbuild';
import externalizeAllPackagesExcept from 'esbuild-plugin-noexternal';
import MagicString from 'magic-string';
import nodeEval from 'eval';
import path from 'path';
import postcss from 'postcss';
import postcssNested from 'postcss-nested';
import postcssScss from 'postcss-scss';
import { ancestor as walk } from 'acorn-walk';
import type { Node, Program, TaggedTemplateExpression, VariableDeclaration } from 'estree';
import type { Plugin, ResolvedConfig } from 'vite';

import hash from './hash.js';

type Options = {
	/**
	 * Should ecsstatic attempt to evaluate expressions (including other class names) used in the template literal?
	 *
	 * Enabling this will only evalulate expressions defined in the same file, which is pretty safe, so it's on by default.
	 *
	 * To evaluate expressions that depend on imports from other files, see the `resolveImports` option.
	 *
	 * @default true
	 */
	evaluateExpressions?: boolean;
	/**
	 * If true, ecsstatic will try its best to resolve relative imports when evaluating expressions.
	 * Note that you still won't be able to use class names generated by ecsstatic in other files.
	 *
	 * To resolve npm package imports, see the `resolvePackages` option.
	 *
	 * @experimental Frankly, resolving imports is a pain in the ass and has an infinite number of edge cases,
	 * so you might see cryptic errors, especially in big files and especially if your project relies on other
	 * vite plugins. This is why this feature disabled by default.
	 *
	 * @default false
	 */
	resolveImports?: boolean;
	/**
	 * By default, packages are also not resolved (everything is "external"-ized) because it is faster this way.
	 * To use an npm package, you can pass its name in an array here.
	 *
	 * @experimental This feature may not work perfectly, because it relies on another experimental option (`resolveImports`).
	 *
	 * @example
	 * export default defineConfig({
	 * 	plugins: [ecsstatic({ resolvePackages: ['open-props'] })],
	 * });
	 */
	resolvePackages?: string[];
};

/**
 * will use `:where` to keep specificity flat when nesting classnames like this:
 * ```
 * const foo = css`...`;
 * const bar = css`
 *   ${foo} & {
 *     // ...
 *   }
 * `;
 * ```
 */
const useWhere = true;

/**
 * Returns the vite plugin for ecsstatic.
 *
 * @example
 * import { ecsstatic } from '@acab/ecsstatic/vite';
 *
 * export default defineConfig({
 * 	plugins: [ecsstatic()],
 * });
 */
export function ecsstatic(options: Options = {}) {
	const {
		evaluateExpressions = true,
		resolvePackages = [],
		resolveImports = evaluateExpressions && resolvePackages.length,
	} = options;

	const cssList = new Map<string, string>();
	let viteConfigObj: ResolvedConfig;

	return <Plugin>{
		name: 'ecsstatic',

		configResolved(_config: ResolvedConfig) {
			viteConfigObj = _config;
		},

		buildStart() {
			cssList.clear();
		},

		buildEnd() {
			cssList.clear();
		},

		resolveId(id, importer) {
			if (!importer) return;

			if (id.endsWith('css')) {
				// relative to absolute
				if (id.startsWith('.')) id = normalizePath(path.join(path.dirname(importer), id));

				if (!cssList.has(id)) {
					// sometimes we need to resolve it based on the root
					id = normalizePath(path.join(viteConfigObj.root, id.startsWith('/') ? id.slice(1) : id));
				}

				if (cssList.has(id)) {
					return id;
				}
			}
			return null;
		},

		load(id) {
			if (cssList.has(id)) {
				const css = cssList.get(id);
				return css;
			}
		},

		async transform(code, id) {
			[id] = id.split('?');
			if (/node_modules/.test(id)) return;
			if (!/(c|m)*(j|t)s(x)*$/.test(id)) return;

			const parsedAst = this.parse(code) as Program;

			const {
				cssImportName,
				scssImportName,
				statements: ecsstaticImportStatements,
			} = findEcsstaticImports(parsedAst);
			if (ecsstaticImportStatements.length === 0) return;

			const ecsstaticImportNames = [cssImportName, scssImportName].filter(Boolean) as string[];

			const cssTemplateLiterals = findCssTaggedTemplateLiterals(parsedAst, ecsstaticImportNames);
			if (cssTemplateLiterals.length === 0) return;

			const magicCode = new MagicString(code);
			let inlinedVars = '';
			const generatedClasses = new Map<string, string>();

			for (const node of cssTemplateLiterals) {
				const originalName = node._originalName || '🎈';
				const { start, end, quasi, tag } = node;
				const isScss = tag.type === 'Identifier' && tag.name === scssImportName;

				// lazy populate inlinedVars until we need it, to delay problems that come with this mess
				if (quasi.expressions.length && resolveImports && !inlinedVars) {
					inlinedVars = await inlineImportsUsingEsbuild(id, { noExternal: resolvePackages });
				}

				const rawTemplate = code.slice(quasi.start, quasi.end).trim();
				const templateContents =
					evaluateExpressions && quasi.expressions.length
						? processTemplateLiteral(rawTemplate, {
								inlinedVars,
								generatedClasses: Object.fromEntries(generatedClasses),
						  })
						: rawTemplate.slice(1, rawTemplate.length - 2);
				const [css, className] = processCss(templateContents, originalName, isScss);

				// save all classes that we know are assigned to variables in this file, but use `:where`
				if (originalName !== '🎈') {
					generatedClasses.set(originalName, useWhere ? `:where(.${className})` : `.${className}`);
				}

				// add processed css to a .css file
				const extension = isScss ? 'scss' : 'css';
				const cssFilename = `${className}.acab.${extension}`.toLowerCase();
				magicCode.append(`import "./${cssFilename}";\n`);
				const fullCssPath = normalizePath(path.join(path.dirname(id), cssFilename));
				cssList.set(fullCssPath, css);

				// replace the tagged template literal with the generated className
				magicCode.update(start, end, `"${className}"`);
			}

			// remove ecsstatic imports, we don't need them anymore
			ecsstaticImportStatements.forEach(({ start, end }) => magicCode.update(start, end, ''));

			return {
				code: magicCode.toString(),
				map: magicCode.generateMap(),
			};
		},
	};
}

/**
 * processes template strings using postcss and
 * returns it along with a hashed classname based on the string contents.
 */
function processCss(templateContents: string, originalName: string, isScss = false) {
	const isImportOrUse = (line: string) =>
		line.trim().startsWith('@import') || line.trim().startsWith('@use');

	const importsAndUses = templateContents
		.split(/\r\n|\r|\n/g)
		.filter(isImportOrUse)
		.join('\n')
		.trim();
	const codeWithoutImportsAndUses = templateContents
		.split(/\r\n|\r|\n/g)
		.filter((line) => !isImportOrUse(line))
		.join('\n');

	const className = `${originalName}-${hash(templateContents)}`;
	const unprocessedCss = `${importsAndUses}\n.${className}{${codeWithoutImportsAndUses}}`;

	const plugins = !isScss ? [postcssNested()] : [];
	const options = isScss ? { parser: postcssScss } : {};
	const { css } = postcss(plugins).process(unprocessedCss, options);

	return [css, className];
}

/** resolves all expressions in the template literal and returns a plain string */
function processTemplateLiteral(rawTemplate: string, { inlinedVars = '', generatedClasses = {} }) {
	try {
		const processedTemplate = evalWithEsbuild(rawTemplate, inlinedVars, generatedClasses) as string;
		return processedTemplate;
	} catch (err) {
		console.error('Unable to resolve expression in template literal');
		throw err;
	}
}

/** parses ast and returns info about all css/scss ecsstatic imports */
function findEcsstaticImports(ast: Program) {
	let cssImportName: string | undefined;
	let scssImportName: string | undefined;
	let statements: Array<{ start: number; end: number }> = [];

	for (const node of ast.body.filter((node) => node.type === 'ImportDeclaration')) {
		if (node.type === 'ImportDeclaration' && node.source.value === '@acab/ecsstatic') {
			const { start, end } = node;
			if (node.specifiers.some(({ imported }: any) => ['css', 'scss'].includes(imported.name))) {
				statements.push({ start, end });
			}
			node.specifiers.forEach((specifier) => {
				if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'css') {
					cssImportName = specifier.local.name;
				}
				if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'scss') {
					scssImportName = specifier.local.name;
				}
			});
		}
	}

	return { cssImportName, scssImportName, statements };
}

/**
 * uses esbuild.transform to tree-shake unused var declarations
 * before evaluating it with node_eval
 */
function evalWithEsbuild(expression: string, allVarDeclarations = '', generatedClasses = {}) {
	// we will manually inject this after allVarDeclarations to prevent shadowing
	const generatedClassesDecls = Object.entries(generatedClasses)
		.map(([key, value]) => `var ${key} = '${value}';`)
		.join('\n');

	const treeshaked = esbuild.transformSync(
		`${allVarDeclarations}\n
		${generatedClassesDecls}\n
		module.exports = (${expression});`,
		{ format: 'cjs', target: 'node14', treeShaking: true }
	);

	return nodeEval(treeshaked.code, hash(expression), generatedClasses, true);
}

/** uses esbuild.build to resolve all imports and return the "bundled" code */
async function inlineImportsUsingEsbuild(fileId: string, options: { noExternal?: string[] }) {
	const { noExternal = [] } = options;

	const processedCode = (
		await esbuild.build({
			entryPoints: [fileId],
			bundle: true,
			format: 'esm',
			write: false,
			platform: 'node',
			logLevel: 'error',
			loader: {
				'.css': 'empty',
				'.svg': 'empty',
			},
			keepNames: true,
			plugins: [loadDummyEcsstatic(), externalizeAllPackagesExcept(noExternal)],
		})
	).outputFiles[0].text;

	// TODO: remove unneeded code, most importantly class name assignments

	return processedCode;
}

/** walks the ast to find all tagged template literals that look like (css`...`) */
function findCssTaggedTemplateLiterals(ast: Program, tagNames: string[]) {
	type TaggedTemplateWithName = TaggedTemplateExpression & { _originalName?: string };

	let nodes: Array<TaggedTemplateWithName> = [];

	walk(ast as any, {
		TaggedTemplateExpression(node, ancestors) {
			const _node = node as TaggedTemplateWithName;

			if (_node.tag.type === 'Identifier' && tagNames.includes(_node.tag.name)) {
				// last node is the current node, so we look at the second last node to find a name
				const prevNode = (ancestors as any[]).at(-2) as Node;

				switch (prevNode?.type) {
					case 'VariableDeclarator': {
						if (
							prevNode.id.type === 'Identifier' &&
							prevNode.init?.start === _node.start &&
							prevNode.init?.end === _node.end
						) {
							_node._originalName = prevNode.id.name;
						}
						break;
					}
					case 'Property': {
						if (
							prevNode.type === 'Property' &&
							prevNode.value.start === _node.start &&
							prevNode.value.end === _node.end &&
							prevNode.key.type === 'Identifier'
						) {
							_node._originalName = prevNode.key.name;
						}
						break;
					}
				}

				nodes.push(_node);
			}
		},
	});

	return nodes;
}

/** esbuild plugin that resolves and loads a dummy version of ecsstatic */
function loadDummyEcsstatic() {
	return <esbuild.Plugin>{
		name: 'load-dummy-ecsstatic',
		setup(build) {
			build.onResolve({ filter: /^@acab\/ecsstatic$/ }, (args) => {
				return {
					namespace: 'ecsstatic',
					path: args.path,
				};
			});
			build.onLoad({ filter: /(.*)/, namespace: 'ecsstatic' }, () => {
				return {
					contents: 'export const css = () => "🎈"; export const scss = () => "🎈";',
					loader: 'js',
				};
			});
		},
	};
}

function normalizePath(original: string) {
	return original.replace(/\\/g, '/').toLowerCase();
}
