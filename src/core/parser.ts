export enum TextType {
  JSON = 1,
  TRAILING_JSON = 2,
  TRUNCATED_JSON = 3,
  MALFORMATED_JSON = 4,
  TEXT = 5
}

export class InvalidFormatError extends Error {
  errorType: TextType;
  errorPos: number;

  constructor(type: TextType, errorPos: number = 0) {
    super(`InvalidFormatError: ${TextType[type]}`);
    this.errorType = type;
    this.errorPos = errorPos;
  }

  getErrorType(): TextType {
    return this.errorType;
  }

  getErrorPos(): number {
    return this.errorPos;
  }
}

// Token constants (mirrors JsonTokens)
const DIGIT0 = '0';
const DIGIT1 = '1';
const DIGIT2 = '2';
const DIGIT3 = '3';
const DIGIT4 = '4';
const DIGIT5 = '5';
const DIGIT6 = '6';
const DIGIT7 = '7';
const DIGIT8 = '8';
const DIGIT9 = '9';
const DIGITS = new Set([DIGIT0, DIGIT1, DIGIT2, DIGIT3, DIGIT4, DIGIT5, DIGIT6, DIGIT7, DIGIT8, DIGIT9]);

const NEGATIVE = '-';
const QUOTER = '"';
const SINGLE_QUOTER = "'";
const LEFT_BRACE = '{';
const RIGHT_BRACE = '}';
const LEFT_BRACKET = '[';
const RIGHT_BRACKET = ']';
const T = 't';
const F = 'f';
const N = 'n';

const DOT = '.';
const PLUS = '+';
const MINUS = '-';
const EXP = 'e';
const BACK_SLASH = '\\';
const COLON = ':';
const COMMA = ',';
const BACK_TICK = '`';

export class JsonParser {
  private pos: number = 0;
  private len: number = 0;
  private json: string = '';
  private startPos: number = 0;
  private textType: TextType = TextType.JSON;

  public getStartPos(): number {
    return this.startPos;
  }

  public getEndPos(): number {
    return this.pos;
  }

  public getTextType(): TextType {
    return this.textType;
  }

  public parse(json: string): any {
    this.json = json;
    this.len = json.length;
    if (this.len < 1) {
      this.textType = TextType.MALFORMATED_JSON;
      return ;
    }

    this._walkToJsonStart();
    if (this.pos >= this.len) {
      this.textType = TextType.TEXT;
      return;
    }
    try {
      this._parse();
      this._walkThroughEmpty();
      if (this.pos < this.len) {
        this.textType = TextType.TRAILING_JSON;
      }
    } catch (error) {
      if (!(error instanceof InvalidFormatError)) {
        this.textType = TextType.MALFORMATED_JSON;
      }
    }
  }

  private _parse(): any {
    this._walkThroughEmpty();
    if (this.pos >= this.len) {
      this.textType = TextType.MALFORMATED_JSON;
      throw new InvalidFormatError(TextType.MALFORMATED_JSON);
    }

    const ch = this.json.charAt(this.pos);
    if (DIGITS.has(ch) || ch === NEGATIVE) {
      return this._parseNumber();
    } else if (ch === QUOTER || ch === SINGLE_QUOTER) {
      return this._parseString(ch);
    } else if (ch === LEFT_BRACE) {
      return this._parseObject();
    } else if (ch === LEFT_BRACKET) {
      return this._parseArray();
    } else if (ch === T) {
      return this._parseTrue();
    } else if (ch === F) {
      return this._parseFalse();
    } else if (ch === N) {
      return this._parseNull();
    } else {
      this.textType = TextType.MALFORMATED_JSON;
      throw new InvalidFormatError(TextType.MALFORMATED_JSON);
    }
  }

  private _walkToJsonStart(): any {
    this._walkThroughEmpty();
    if (this.pos >= this.len) {
      this.textType = TextType.MALFORMATED_JSON;
    }
    let ch = this.json.charAt(this.pos);
    let inCodeFence = false;
    while (this.pos < this.len && ((ch !== LEFT_BRACE && ch !== LEFT_BRACKET) || inCodeFence)) {
      if (inCodeFence && ch !== BACK_TICK) {
        if (this._movePositionNonJson()) {
          ch = this.json.charAt(this.pos);
          continue;
        } else {
          break;
        }
      }

      if (ch == BACK_TICK) {
        let btCount = 0;
        while(ch === BACK_TICK && this._movePositionNonJson()) {
          ch = this.json.charAt(this.pos);
          btCount++;
        }

        if (btCount > 2) {
          inCodeFence = !inCodeFence;
        }
      } else {
        if (this._movePositionNonJson()) {
          ch = this.json.charAt(this.pos);
        } else {
          break;
        }
      }
    }
    if (this.pos < this.len && (ch === LEFT_BRACE || ch === LEFT_BRACKET)) {
      this.startPos = this.pos;
    }
  }

  private _parseNumber(): number {
    let isFloat = false;
    const start = this.pos;
    let ch = this.json.charAt(this.pos);

    if (ch === NEGATIVE) {
      this._movePosition();
      if (!this._isDigit(this.json.charAt(this.pos)) || this.json.charAt(this.pos) === DIGIT0) {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }
    } else if (ch === DIGIT0) {
      if (this.pos < this.len - 1) {
        this.pos += 1;
        if (this._isDigit(this.json.charAt(this.pos))) {
          this.textType = TextType.MALFORMATED_JSON;
          throw new InvalidFormatError(TextType.MALFORMATED_JSON);
        }
      }
    }

    while (this.pos < this.len && this._isDigit(this.json.charAt(this.pos))) {
      this.pos += 1;
    }

    if (this.pos < this.len && this.json.charAt(this.pos) === DOT) {
      isFloat = true;
      this._movePosition();
      if (!this._isDigit(this.json.charAt(this.pos))) {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }
    }

    while (this.pos < this.len && this._isDigit(this.json.charAt(this.pos))) {
      this.pos += 1;
    }

    if (this.pos < this.len && this.json.charAt(this.pos).toLowerCase() === EXP) {
      isFloat = true;
      this._movePosition();
      const nextCh = this.json.charAt(this.pos);
      if (this._isDigit(nextCh)) {
        while (this.pos < this.len && this._isDigit(this.json.charAt(this.pos))) {
          this.pos += 1;
        }
      } else if (nextCh === PLUS || nextCh === MINUS) {
        this._movePosition();
        if (!this._isDigit(this.json.charAt(this.pos))) {
          this.textType = TextType.MALFORMATED_JSON;
          throw new InvalidFormatError(TextType.MALFORMATED_JSON);
        }
        while (this.pos < this.len && this._isDigit(this.json.charAt(this.pos))) {
          this.pos += 1;
        }
      } else {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }
    }

    const numStr = this.json.substring(start, this.pos);

    if (isFloat) {
      return parseFloat(numStr);
    } else {
      return parseInt(numStr, 10);
    }
  }

  private _parseString(quoter: string): string {
    this.pos += 1;
    const start = this.pos;
    let escaping = false;
    while (this.pos < this.len && (this.json.charAt(this.pos) !== quoter || escaping)) {
      const ch = this.json.charAt(this.pos);
      if (ch === BACK_SLASH) {
        escaping = !escaping;
      } else {
        if (escaping) {
          escaping = false;
        }
      }
      this.pos += 1;
    }

    if ((this.pos <= start && this.pos >= this.len) || (this.pos >= this.len && this.json.charAt(this.pos - 1) !== quoter)) {
      this.textType = TextType.TRUNCATED_JSON;
      throw new InvalidFormatError(TextType.TRUNCATED_JSON);
    }

    const strVal = this.json.substring(start, this.pos);
    this.pos += 1;

    return strVal;
  }

  private _parseObject(): Record<string, any> {
    this.pos += 1;
    this._walkThroughEmpty();
    if (this.pos >= this.len) {
      this.textType = TextType.TRUNCATED_JSON;
      throw new InvalidFormatError(TextType.TRUNCATED_JSON);
    }

    const result: Record<string, any> = {};
    while (this.pos < this.len && this.json.charAt(this.pos) !== RIGHT_BRACE) {
      this._walkThroughEmpty();
      if (this.pos >= this.len) {
        this.textType = TextType.TRUNCATED_JSON;
        throw new InvalidFormatError(TextType.TRUNCATED_JSON);
      }
      if (this.json.charAt(this.pos) !== QUOTER && this.json.charAt(this.pos) !== SINGLE_QUOTER) {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }

      const key = this._parse();
      this._walkThroughEmpty();
      if (this.pos >= this.len) {
        this.textType = TextType.TRUNCATED_JSON;
        throw new InvalidFormatError(TextType.TRUNCATED_JSON);
      }
      if (this.json.charAt(this.pos) !== COLON) {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }

      this._movePosition();
      const value = this._parse();
      this._walkThroughEmpty();
      if (this.pos >= this.len) {
        this.textType = TextType.TRUNCATED_JSON;
        throw new InvalidFormatError(TextType.TRUNCATED_JSON);
      }
      if (this.json.charAt(this.pos) !== COMMA && this.json.charAt(this.pos) !== RIGHT_BRACE) {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }

      result[key] = value;
      if (this.json.charAt(this.pos) === COMMA) {
        this._movePosition();
      }
    }

    if (this.pos >= this.len && this.json.charAt(this.pos - 1) !== RIGHT_BRACE) {
      this.textType = TextType.TRUNCATED_JSON;
      throw new InvalidFormatError(TextType.TRUNCATED_JSON);
    }
    this.pos += 1;

    return result;
  }

  private _parseArray(): any[] {
    this.pos += 1;
    this._walkThroughEmpty();
    if (this.pos >= this.len) {
      this.textType = TextType.TRUNCATED_JSON;
      throw new InvalidFormatError(TextType.TRUNCATED_JSON);
    }

    const result: any[] = [];
    while (this.pos < this.len && this.json.charAt(this.pos) !== RIGHT_BRACKET) {
      const value = this._parse();
      this._walkThroughEmpty();
      if (this.pos >= this.len) {
        this.textType = TextType.TRUNCATED_JSON;
        throw new InvalidFormatError(TextType.TRUNCATED_JSON);
      }
      if (this.json.charAt(this.pos) !== COMMA && this.json.charAt(this.pos) !== RIGHT_BRACKET) {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }

      result.push(value);
      if (this.json.charAt(this.pos) === COMMA) {
        this._movePosition();
      }
      this._walkThroughEmpty();
    }

    if (this.pos >= this.len && this.json.charAt(this.pos - 1) !== RIGHT_BRACKET) {
      this.textType = TextType.TRUNCATED_JSON;
      throw new InvalidFormatError(TextType.TRUNCATED_JSON);
    }
    this.pos += 1;

    return result;
  }

  private _parseTrue(): true {
    this._movePosition();
    if (this.json.charAt(this.pos) === 'r') {
      this._movePosition();
      if (this.json.charAt(this.pos) === 'u') {
        this._movePosition();
        if (this.json.charAt(this.pos) === 'e') {
          this.pos += 1;
          return true;
        } else {
          this.textType = TextType.MALFORMATED_JSON;
          throw new InvalidFormatError(TextType.MALFORMATED_JSON);
        }
      } else {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }
    } else {
      this.textType = TextType.MALFORMATED_JSON;
      throw new InvalidFormatError(TextType.MALFORMATED_JSON);
    }
  }

  private _parseFalse(): false {
    this._movePosition();
    if (this.json.charAt(this.pos) === 'a') {
      this._movePosition();
      if (this.json.charAt(this.pos) === 'l') {
        this._movePosition();
        if (this.json.charAt(this.pos) === 's') {
          this._movePosition();
          if (this.json.charAt(this.pos) === 'e') {
            this.pos += 1;
            return false;
          } else {
            throw new InvalidFormatError(TextType.MALFORMATED_JSON);
          }
        } else {
          throw new InvalidFormatError(TextType.MALFORMATED_JSON);
        }
      } else {
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }
    } else {
      throw new InvalidFormatError(TextType.MALFORMATED_JSON);
    }
  }

  private _parseNull(): null {
    this._movePosition();
    if (this.json.charAt(this.pos) === 'u') {
      this._movePosition();
      if (this.json.charAt(this.pos) === 'l') {
        this._movePosition();
        if (this.json.charAt(this.pos) === 'l') {
          this.pos += 1;
          return null;
        } else {
          this.textType = TextType.MALFORMATED_JSON;
          throw new InvalidFormatError(TextType.MALFORMATED_JSON);
        }
      } else {
        this.textType = TextType.MALFORMATED_JSON;
        throw new InvalidFormatError(TextType.MALFORMATED_JSON);
      }
    } else {
      this.textType = TextType.MALFORMATED_JSON;
      throw new InvalidFormatError(TextType.MALFORMATED_JSON);
    }
  }

  private _walkThroughEmpty(): void {
    while (this.pos < this.len && /\s/.test(this.json.charAt(this.pos))) {
      this.pos += 1;
    }
  }

  private _isDigit(ch: string): boolean {
    return DIGITS.has(ch);
  }

  private _movePosition(): string {
    this.pos += 1;
    if (this.pos >= this.len) {
      this.textType = TextType.MALFORMATED_JSON;
      throw new InvalidFormatError(TextType.MALFORMATED_JSON);
    }

    return this.json.charAt(this.pos);
  }

  private _movePositionNonJson(): boolean {
    this.pos += 1;
    return this.pos < this.len;
  }
}
