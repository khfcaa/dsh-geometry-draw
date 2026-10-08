/**
 * 坐标表达式求值器。
 *
 * 递归下降、手写、不使用 `eval` / `new Function`——模型给的文本永远只是数据。
 * 支持隐式乘法（`2x`、`3sin(t)`）、常量（pi/e/tau/phi）、常用函数与变量表，
 * 与 `math_figure` 的表达式方言保持兼容，减少用户的迁移成本。
 */

const FUNCTIONS = {
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	atan2: Math.atan2,
	sinh: Math.sinh,
	cosh: Math.cosh,
	tanh: Math.tanh,
	asinh: Math.asinh,
	acosh: Math.acosh,
	atanh: Math.atanh,
	sqrt: Math.sqrt,
	cbrt: Math.cbrt,
	abs: Math.abs,
	exp: Math.exp,
	ln: Math.log,
	log: Math.log10,
	log2: Math.log2,
	log10: Math.log10,
	floor: Math.floor,
	ceil: Math.ceil,
	round: Math.round,
	trunc: Math.trunc,
	sign: Math.sign,
	min: Math.min,
	max: Math.max,
	pow: Math.pow,
	hypot: Math.hypot,
	mod: (a, b) => ((a % b) + b) % b,
	gcd: (a, b) => {
		let x = Math.abs(Math.round(a));
		let y = Math.abs(Math.round(b));
		while (y > 0) [x, y] = [y, x % y];
		return x;
	},
	cot: (a) => 1 / Math.tan(a),
	sec: (a) => 1 / Math.cos(a),
	csc: (a) => 1 / Math.sin(a),
};

const CONSTANTS = {
	pi: Math.PI,
	π: Math.PI,
	tau: Math.PI * 2,
	τ: Math.PI * 2,
	e: Math.E,
	phi: (1 + Math.sqrt(5)) / 2,
	φ: (1 + Math.sqrt(5)) / 2,
};

const MAX_LENGTH = 2000;
const MAX_DEPTH = 64;

class Tokenizer {
	constructor(source) {
		this.source = source;
		this.index = 0;
	}

	peek() {
		return this.source[this.index];
	}

	eof() {
		return this.index >= this.source.length;
	}

	skipSpaces() {
		while (!this.eof() && /\s/.test(this.source[this.index])) this.index += 1;
	}

	/** 读一个标识符（允许 π/θ/φ 等希腊字母与下划线数字） */
	readIdentifier() {
		const start = this.index;
		while (!this.eof() && /[A-Za-z_\u03b1-\u03c9\u0391-\u03a9]/.test(this.source[this.index])) this.index += 1;
		return this.source.slice(start, this.index);
	}

	readNumber() {
		const start = this.index;
		while (!this.eof() && /[0-9.]/.test(this.source[this.index])) this.index += 1;
		if (this.peek() === 'e' || this.peek() === 'E') {
			const save = this.index;
			this.index += 1;
			if (this.peek() === '+' || this.peek() === '-') this.index += 1;
			if (/[0-9]/.test(this.peek() ?? '')) {
				while (!this.eof() && /[0-9]/.test(this.source[this.index])) this.index += 1;
			} else {
				this.index = save;
			}
		}
		const text = this.source.slice(start, this.index);
		if (text === '' || text === '.') throw new Error(`expression: expected a number at position ${start}`);
		return Number(text);
	}
}

/**
 * 编译表达式为求值函数。变量名集合由调用方给出（例如几何规格里的 `t`、`theta`、
 * 以及 `vars` 声明的名字）。未知变量/函数、参数个数不符都会在此刻报错。
 */
export function compileExpression(source, variables = []) {
	if (typeof source !== 'string') throw new Error('expression: expected a string');
	const text = source.trim();
	if (text.length === 0) throw new Error('expression: empty');
	if (text.length > MAX_LENGTH) throw new Error(`expression: longer than ${MAX_LENGTH} characters`);

	// 变量表：既接受名字数组，也接受「名字 → 当前值」的对象（后者更常见，
	// 因为调用方手里通常就是 vars 对象本身）。
	const variableSet = new Set(Array.isArray(variables) ? variables : Object.keys(variables));
	const tokenizer = new Tokenizer(text);

	const parseExpression = (depth) => {
		if (depth > MAX_DEPTH) throw new Error('expression: nested too deeply');
		let left = parseTerm(depth + 1);
		for (;;) {
			tokenizer.skipSpaces();
			const ch = tokenizer.peek();
			if (ch === '+' || ch === '-') {
				tokenizer.index += 1;
				const right = parseTerm(depth + 1);
				const lhs = left;
				left = ch === '+' ? (env) => lhs(env) + right(env) : (env) => lhs(env) - right(env);
			} else {
				return left;
			}
		}
	};

	const parseTerm = (depth) => {
		if (depth > MAX_DEPTH) throw new Error('expression: nested too deeply');
		let left = parseUnary(depth + 1);
		for (;;) {
			tokenizer.skipSpaces();
			const ch = tokenizer.peek();
			if (ch === '*' || ch === '/' || ch === '%') {
				tokenizer.index += 1;
				const right = parseUnary(depth + 1);
				const lhs = left;
				if (ch === '*') left = (env) => lhs(env) * right(env);
				else if (ch === '/') left = (env) => lhs(env) / right(env);
				else left = (env) => ((lhs(env) % right(env)) + right(env)) % right(env);
			} else if (ch !== undefined && isImplicitMultiplicationStart(ch)) {
				// 隐式乘法：2x、3sin(t)、2(x+1)、(x+1)(x-1)
				const right = parseUnary(depth + 1);
				const lhs = left;
				left = (env) => lhs(env) * right(env);
			} else {
				return left;
			}
		}
	};

	const parseUnary = (depth) => {
		tokenizer.skipSpaces();
		if (tokenizer.peek() === '-') {
			tokenizer.index += 1;
			const operand = parseUnary(depth + 1);
			return (env) => -operand(env);
		}
		if (tokenizer.peek() === '+') {
			tokenizer.index += 1;
			return parseUnary(depth + 1);
		}
		return parsePower(depth + 1);
	};

	const parsePower = (depth) => {
		const base = parseAtom(depth + 1);
		tokenizer.skipSpaces();
		if (tokenizer.peek() === '^') {
			tokenizer.index += 1;
			// 右结合
			const exponent = parseUnary(depth + 1);
			return (env) => base(env) ** exponent(env);
		}
		return base;
	};

	const parseAtom = (depth) => {
		tokenizer.skipSpaces();
		const ch = tokenizer.peek();
		if (ch === undefined) throw new Error('expression: unexpected end of input');
		if (ch === '(') {
			tokenizer.index += 1;
			const inner = parseExpression(depth + 1);
			tokenizer.skipSpaces();
			if (tokenizer.peek() !== ')') throw new Error('expression: missing ")"');
			tokenizer.index += 1;
			return inner;
		}
		if (/[0-9.]/.test(ch)) {
			const value = tokenizer.readNumber();
			return () => value;
		}
		if (/[A-Za-z_\u03b1-\u03c9\u0391-\u03a9]/.test(ch)) {
			const identifier = tokenizer.readIdentifier();
			tokenizer.skipSpaces();
			if (tokenizer.peek() === '(') {
				const fn = FUNCTIONS[identifier];
				if (fn === undefined) throw new Error(`expression: unknown function "${identifier}"`);
				tokenizer.index += 1;
				const args = [];
				tokenizer.skipSpaces();
				if (tokenizer.peek() !== ')') {
					for (;;) {
						args.push(parseExpression(depth + 1));
						tokenizer.skipSpaces();
						if (tokenizer.peek() === ',') {
							tokenizer.index += 1;
							continue;
						}
						break;
					}
				}
				if (tokenizer.peek() !== ')') throw new Error(`expression: missing ")" after "${identifier}("`);
				tokenizer.index += 1;
				return (env) => fn(...args.map((arg) => arg(env)));
			}
			if (identifier in CONSTANTS) {
				const value = CONSTANTS[identifier];
				return () => value;
			}
			if (variableSet.has(identifier)) {
				return (env) => {
					const value = env[identifier];
					return typeof value === 'number' ? value : Number.NaN;
				};
			}
			const known = [...variableSet].sort().join(', ');
			throw new Error(`expression: unknown variable "${identifier}"${known ? ` (available: ${known})` : ''}`);
		}
		throw new Error(`expression: unexpected character "${ch}"`);
	};

	const compiled = parseExpression(0);
	tokenizer.skipSpaces();
	if (!tokenizer.eof()) throw new Error(`expression: unexpected trailing input at position ${tokenizer.index}`);

	return (env = {}) => {
		const value = compiled(env);
		if (typeof value !== 'number' || Number.isNaN(value)) {
			throw new Error(`expression "${text}" evaluated to ${value}`);
		}
		return value;
	};
}

function isImplicitMultiplicationStart(ch) {
	return /[0-9A-Za-z_(\u03b1-\u03c9\u0391-\u03a9]/.test(ch);
}

/**
 * 规格里凡是「数值或表达式」的字段都走这里：数字直通，字符串编译。
 * `values` 是该表达式可用的变量（通常就是 `vars`），可以是数组或对象。
 */
export function resolveNumber(value, values, what) {
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${what}: expected a finite number`);
		return value;
	}
	if (typeof value === 'string') {
		const env = Array.isArray(values) ? {} : (values ?? {});
		const names = Array.isArray(values) ? values : Object.keys(env);
		return compileExpression(value, names)(env);
	}
	throw new Error(`${what}: expected a number or an expression string`);
}

export function isExpression(value) {
	return typeof value === 'string';
}
