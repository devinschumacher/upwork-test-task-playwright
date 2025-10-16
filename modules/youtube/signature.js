// Signature decryptor (trimmed)
import { getPlayerCacheKey, escapeRegex, makePlayerUrlAbsolute } from './utils.js';

export class YouTubeSignatureDecryptor {
  constructor() {
    this.playerCache = new Map();
    this.signatureCache = new Map();
    this.nsigCache = new Map();
  }

  async decryptSignatureCipher(signatureCipher, videoId, playerUrl) {
    const params = new URLSearchParams(signatureCipher);
    const url = params.get('url');
    const s = params.get('s');
    const sp = params.get('sp') || 'signature';
    if (!url || !s) return null;
    const sig = await this.decryptSignature(s, videoId, playerUrl);
    if (!sig) return null;
    return `${url}&${sp}=${encodeURIComponent(sig)}`;
  }

  async decryptSignature(signature, videoId, playerUrl) {
    const cacheKey = getPlayerCacheKey(playerUrl || '');
    try {
      const res = await this.decryptSignatureWithDynamicExecution(signature, playerUrl, cacheKey);
      if (res) return res;
    } catch {}
    if (this.signatureCache.has(cacheKey)) {
      const fn = this.signatureCache.get(cacheKey);
      return fn(signature);
    }
    const fn = await this.extractSignatureFunction(playerUrl);
    if (!fn) return null;
    this.signatureCache.set(cacheKey, fn);
    return fn(signature);
  }

  async getPlayerCode(playerUrl) {
    const abs = makePlayerUrlAbsolute(playerUrl);
    if (this.playerCache.has(abs)) return this.playerCache.get(abs);
    const res = await fetch(abs);
    const code = await res.text();
    this.playerCache.set(abs, code);
    return code;
  }

  async extractSignatureFunction(playerUrl) {
    const code = await this.getPlayerCode(playerUrl);
    const name = this.findSignatureFunctionName(code);
    if (!name) return null;
    const body = this.extractFunctionCode(code, name);
    if (!body) return null;
    const helper = this.findHelperObject(code, body);
    const helpersSrc = helper ? `var ${helper.name}=${helper.code};\n` : '';
    const fnSrc = `${helpersSrc}var ${name}=function(a){${body}}; ${name}`;
    const fn = (sig) => {
      // eslint-disable-next-line no-eval
      const f = eval(fnSrc);
      return f(sig);
    };
    return fn;
  }

  findSignatureFunctionName(code) {
    const patterns = [
      /\.sig\|\|([a-zA-Z0-9$]+)\(/,
      /\b([a-zA-Z0-9_$]{2,})\s*=\s*function\(\s*a\s*\)\s*{\s*a\s*=\s*a\.split\(\s*""\s*\)/,
      /\b([a-zA-Z0-9_$]+)\s*=\s*function\(\s*([a-zA-Z0-9_$]+)\s*\)\s*{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/
    ];
    for (const p of patterns) {
      const m = code.match(p);
      if (m) return m[1];
    }
    return null;
  }

  extractFunctionCode(code, fnName) {
    // Try assignment form: name=function(a){...}
    let pos = code.indexOf(`${fnName}=function(`);
    // Try declaration form: function name(a){...}
    if (pos === -1) pos = code.indexOf(`function ${fnName}(`);
    // Try object method form: name:function(a){...}
    if (pos === -1) pos = code.indexOf(`${fnName}:function(`);
    if (pos === -1) return null;
    const brace = code.indexOf('{', pos);
    let i = brace + 1, depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
      i++;
    }
    return code.slice(brace + 1, i - 1);
  }

  findHelperObject(code, fnBody) {
    const objMatch = fnBody.match(/([A-Za-z0-9_$]{2})\.[A-Za-z0-9_$]{2}\(a,\d+\)/);
    if (!objMatch) return null;
    const objName = objMatch[1];
    const objRegex = new RegExp(`var\\s+${escapeRegex(objName)}=\\{[^}]+\\}`);
    const m = code.match(objRegex);
    if (!m) return null;
    return { name: objName, code: m[0].replace(/^var\s+[^=]+=\s*/, '') };
  }

  async decryptSignatureWithDynamicExecution(signature, playerUrl, cacheKey) {
    if (!chrome?.scripting?.executeScript) throw new Error('no scripting');
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs?.length) throw new Error('no active tab');
    const playerCode = await this.getPlayerCode(playerUrl);
    const components = this.buildExecComponents(playerCode);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: 'ISOLATED',
      func: (components, s) => {
        try {
          const { helperName, helperCode, fnName, fnBody } = components;
          let ctx = '';
          if (helperName && helperCode) ctx += `var ${helperName}=${helperCode};\n`;
          ctx += `var ${fnName}=function(a){${fnBody}};`;
          // eslint-disable-next-line no-eval
          const f = eval(ctx + `\n${fnName}`);
          return f(s);
        } catch (e) { return null; }
      },
      args: [components, signature]
    });
    return result || null;
  }

  buildExecComponents(playerCode) {
    const fnName = this.findSignatureFunctionName(playerCode);
    const fnBody = this.extractFunctionCode(playerCode, fnName) || '';
    const helper = this.findHelperObject(playerCode, fnBody);
    return { fnName, fnBody, helperName: helper?.name, helperCode: helper?.code };
  }

  // --- n-parameter handling ---
  findNFunctionName(code) {
    const patterns = [
      /[,;]([A-Za-z0-9_$]{2,})\(n\)/,
      /\bnParam\s*=\s*([A-Za-z0-9_$]{2,})\(/,
      /\b([A-Za-z0-9_$]{2,})\s*=\s*function\(\w\)\{[^}]*?\.split\(\"\"\)[^}]*?\}/,
    ];
    for (const p of patterns) {
      const m = code.match(p);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  async decryptNParam(nParam, playerUrl) {
    if (!chrome?.scripting?.executeScript) return null;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs?.length) return null;
    const code = await this.getPlayerCode(playerUrl);
    const name = this.findNFunctionName(code);
    if (!name) return null;
    const body = this.extractFunctionCode(code, name);
    if (!body) return null;
    const helper = this.findHelperObject(code, body);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: 'ISOLATED',
      func: (components, n) => {
        try {
          const { helperName, helperCode, fnName, fnBody } = components;
          let ctx = '';
          if (helperName && helperCode) ctx += `var ${helperName}=${helperCode};\n`;
          ctx += `var ${fnName}=function(a){${fnBody}};`;
          // eslint-disable-next-line no-eval
          const f = eval(ctx + `\n${fnName}`);
          return f(n);
        } catch (e) { return null; }
      },
      args: [{ helperName: helper?.name, helperCode: helper?.code, fnName: name, fnBody: body }, nParam]
    });
    return result || null;
  }

  async transformNUrl(url, playerUrl) {
    try {
      const u = new URL(url);
      const n = u.searchParams.get('n');
      if (!n) return url;
      const t = await this.decryptNParam(n, playerUrl);
      console.log('[YT] n-transform', { before: n, after: t ? t.slice(0, 12) + '...' : null });
      if (!t) return url;
      u.searchParams.set('n', t);
      return u.toString();
    } catch {
      return url;
    }
  }
}
