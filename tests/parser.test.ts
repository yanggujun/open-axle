import { InvalidFormatError, JsonParser, TextType } from '../src/core/parser';

describe('JsonParser', () => {
  it('Normal json string', () => {
    const json = '{"a":1}';
    const parser = new JsonParser();

    // parse() returns undefined; the parser exposes its state via getters.
    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.JSON);
    expect(parser.getStartPos()).toBe(0);
    expect(parser.getEndPos()).toBe(json.length); // 7
  });
});

describe('JsonParser', () => {
  it('Embedded json string', () => {
    const json = 'a{"a":1}b';
    const parser = new JsonParser();

    // parse() returns undefined; the parser exposes its state via getters.
    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.TRAILING_JSON);
    expect(parser.getStartPos()).toBe(1);
    expect(parser.getEndPos()).toBe(json.length - 1); 
  });
});

describe('JsonParser', () => {
  it('Trailing json string', () => {
    const json = '{"a":1}b';
    const parser = new JsonParser();

    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.TRAILING_JSON);
    expect(parser.getStartPos()).toBe(0);
    expect(parser.getEndPos()).toBe(json.length - 1); 
  });
});

describe('JsonParser', () => {
  it('Plain text', () => {
    const json = 'abc';
    const parser = new JsonParser();
    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.TEXT);
  });
});

describe('JsonParser', () => {
  it('Plain text with code', () => {
    const json = 'abc```json\n{"a": 1}\n```';
    const parser = new JsonParser();

    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.TEXT);
  });
});

describe('JsonParser', () => {
  it('Plain text with code long back tick', () => {
    const json = 'abc`````java\nint a = 1\n```';
    const parser = new JsonParser();

    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.TEXT);
  });
});

describe('JsonParser', () => {
  it('Embedded json with code in plain text', () => {
    const json = 'abc`````java\npublic String getter()\n {\nreturn "a";\n}\n``````\n{"a": "b"}';
    const parser = new JsonParser();

    parser.parse(json);

    expect(parser.getTextType()).toBe(TextType.JSON);
    expect(json.substring(parser.getStartPos(), parser.getEndPos())).toBe('{"a": "b"}');
  });
});

describe('JsonParser', () => {
  it('Truncated json', () => {
    const json = '{"a": "m"';
    const parser = new JsonParser();

    parser.parse(json);
    expect(parser.getTextType()).toBe(TextType.TRUNCATED_JSON);
  });
});

describe('JsonParser', () => {
  it('Truncated string json', () => {
    const json = '{"a": "m';
    const parser = new JsonParser();

    parser.parse(json);
    expect(parser.getTextType()).toBe(TextType.TRUNCATED_JSON);
  });
});

describe('JsonParser', () => {
  it('json with value escaped', () => {
    const json = '{"a": "a\nc"}';
    const parser = new JsonParser();

    parser.parse(json);
    expect(parser.getTextType()).toBe(TextType.JSON);
  });
});

describe('JsonParser', () => {
  it('Malformed json', () => {
    const json = '{"a" "b"}';
    const parser = new JsonParser();

    parser.parse(json);
    expect(parser.getTextType()).toBe(TextType.MALFORMATED_JSON);
  });
});