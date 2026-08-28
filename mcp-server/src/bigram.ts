// 与主项目 lib/session-store.ts 的 bigramTokens 保持同步（本包独立编译，不做跨包 import）。
// 同步约束：主应用写入 FTS（title/transcript_text）与本 server 的查询侧分词必须逐字一致，
// 任一侧改动都必须同步另一侧，否则中文检索会静默失配。

// CJK 统一表意文字（含扩展 A 区）；与主项目保持一致。
const CJK_CHAR_PATTERN = /[\u4e00-\u9fa5\u3400-\u4dbf]/;
const ASCII_WORD_CHAR_PATTERN = /[A-Za-z0-9_]/;

/**
 * 中文 2-gram 切分：CJK 字符两两成词（单独成串的单字自成一词），
 * ASCII 词按空白/标点切整词（小写化）。用于 FTS5 默认分词器下可用的中文检索。
 */
export function bigramTokens(text: string): string[] {
  const tokens: string[] = [];
  let asciiRun = "";
  let cjkRun = "";
  const flushAscii = (): void => {
    if (asciiRun.length > 0) {
      tokens.push(asciiRun.toLowerCase());
      asciiRun = "";
    }
  };
  const flushCjk = (): void => {
    if (cjkRun.length === 1) {
      tokens.push(cjkRun);
    } else if (cjkRun.length > 1) {
      for (let index = 0; index < cjkRun.length - 1; index += 1) {
        tokens.push(cjkRun.slice(index, index + 2));
      }
    }
    cjkRun = "";
  };
  for (const char of text) {
    if (CJK_CHAR_PATTERN.test(char)) {
      flushAscii();
      cjkRun += char;
    } else if (ASCII_WORD_CHAR_PATTERN.test(char)) {
      flushCjk();
      asciiRun += char;
    } else {
      flushAscii();
      flushCjk();
    }
  }
  flushAscii();
  flushCjk();
  return tokens;
}
