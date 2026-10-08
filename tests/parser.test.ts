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

describe('JsonParser', () => {
  it('JSON after a text', () => {
    const json = `
      I now understand getSkillConfig(skillName, name): it reads .skill.config → skill_configs , finds the entry whose skill === skillName, then returns the value of the config_items[] entry whose name === name. So to build a remote-server list I need to enumerate item names under the ssh/scp skills.


      Now let me find the 'change dir' button and the folder-selection dialog.


      {
      "action": "grep_file",
      "thinking": "executor.ts understood. Now for task (2): locate the 'change dir' button. I'll do a case-insensitive regex search covering variants: change dir, Change Dir, changeDir, changeDirectory, change_dir, etc. Then I'll read the matching UI file(s) to find the folder selection dialog. The grep result feeds the remaining read/modify tasks, so a sequential.prompt listing ALL remaining tasks is included.",
      "sequential": {
      "prompt": "You are helping modify the open-axle codebase. Context already learned: src/core/executor.ts contains getSkillConfig(skillName, name) which reads the '.skill.config' file (at getAppHome()), scans fullConfig.skill_configs[], finds the entry with entry.skill === skillName, then returns the value of the config_items[] item whose name === name. The '.skill.config' structure is: { skill_configs: [ { skill: 'ssh'|'scp'|..., config_items: [ { name: '', value: { host, port, user_name, auth_type, pass, key_file } } ] } ] }.\n\nThe grep result below lists files matching the 'change dir' button. Continue completing ALL of the following tasks in order, without dropping any:\n\n(2) [IN PROGRESS] Identify the exact file + line of the 'change dir' button (variants: change dir / Change Dir / changeDir / changeDirectory). Identify the pop-up folder selection dialog component it opens.\n\n(3) Read that folder selection dialog component IN FULL to understand its current structure (so the existing selection UI can become the first tab labeled 'local').\n\n(4) Modify the dialog: keep the existing selection dialog as the first tab named 'local', and add a second tab named 'remote'.\n\n(5) On the new 'remote' tab, add a drop-down list for selecting remote servers. The servers must be loaded from the '.skill.config' file's 'ssh' and 'scp' skill config items.\n\n(6) In executor.ts, add a NEW method (alongside the existing getSkillConfig) that returns the remote servers list extracted from the 'ssh' and 'scp' skills in '.skill.config'. Reuse getSkillConfig. Then explain exactly where to call it from the remote tab of the dialog (which IPC/preload/renderer wiring is needed).\n\n(7) Provide the concrete code changes (edits/new methods) needed for executor.ts and the dialog component, plus the wiring for the drop-down. Report file paths and the exact modifications required."
      },
      "properties": [
      { "name": "pattern", "value": "change[ _-]?dir" },
      { "name": "path", "value": "C:/HOME/workspace/ai/open-axle/src/" },
      { "name": "recursive", "value": "true" },
      { "name": "isRegex", "value": "true" },
      { "name": "caseSensitive", "value": "false" },
      { "name": "includeGlob", "value": "*" },
      { "name": "excludeGlob", "value": ".git,node_modules,pycache,.venv,dist,build,out,.webpack" },
      { "name": "maxResults", "value": "100" },
      { "name": "showLines", "value": "true" },
      { "name": "description", "value": "Find the 'change dir' button and related code" }
      ]
      }
      `;
    
    const parser = new JsonParser();

    parser.parse(json);
    expect(parser.getTextType()).toBe(TextType.MALFORMATED_JSON);
  });
});