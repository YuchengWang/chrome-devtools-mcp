/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {SnapshotFormatter} from '../../src/formatters/SnapshotFormatter.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';
import type {ElementHandle} from '../../src/third_party/browser.js';
import type {TextSnapshotNode} from '../../src/types.js';

describe('snapshotFormatter', () => {
  function createNode(
    id: string,
    role: string,
    name: string,
    children: TextSnapshotNode[] = [],
  ): TextSnapshotNode {
    return {
      id,
      role,
      name,
      children,
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };
  }

  it('omits the StaticText role in text output', () => {
    const node = createNode('1_1', 'link', 'Privacy', [
      createNode('1_2', 'StaticText', 'Privacy Policy'),
    ]);

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 link "Privacy"
  uid=1_2 "Privacy Policy"
`,
    );
    assert.deepStrictEqual(formatter.toJSON(), {
      id: '1_1',
      role: 'link',
      name: 'Privacy',
      children: [{id: '1_2', role: 'StaticText', name: 'Privacy Policy'}],
    });
  });

  it('omits uid= when node id is empty', () => {
    const node = createNode('1_1', 'paragraph', 'alpha', [
      createNode('', 'InlineTextBox', 'alpha'),
    ]);

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 paragraph "alpha"
  InlineTextBox "alpha"
`,
    );
    assert.deepStrictEqual(formatter.toJSON(), {
      id: '1_1',
      role: 'paragraph',
      name: 'alpha',
      children: [{role: 'InlineTextBox', name: 'alpha'}],
    });
  });

  it('skips the only StaticText child duplicating the parent name', () => {
    const node = createNode('1_1', 'link', 'Privacy Policy', [
      createNode('1_2', 'StaticText', 'Privacy Policy'),
    ]);

    const formatter = new SnapshotFormatter({
      root: node,
      verbose: false,
    } as TextSnapshot);
    assert.strictEqual(formatter.toString(), `uid=1_1 link "Privacy Policy"\n`);
  });

  it('keeps the duplicate StaticText child in verbose mode', () => {
    const node = createNode('1_1', 'link', 'Privacy Policy', [
      createNode('1_2', 'StaticText', 'Privacy Policy'),
    ]);

    const formatter = new SnapshotFormatter({
      root: node,
      verbose: true,
    } as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 link "Privacy Policy"
  uid=1_2 "Privacy Policy"
`,
    );
  });

  it('keeps the duplicate StaticText child if it has non-text siblings', () => {
    const node = createNode('1_1', 'link', 'Privacy Policy', [
      createNode('1_2', 'StaticText', 'Privacy Policy'),
      createNode('1_3', 'image', 'icon'),
    ]);

    const formatter = new SnapshotFormatter({
      root: node,
      verbose: false,
    } as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 link "Privacy Policy"
  uid=1_2 "Privacy Policy"
  uid=1_3 image "icon"
`,
    );
  });

  it('skips StaticText children whose combined text equals the parent name', () => {
    const node = createNode('1_1', 'link', 'English 7,245,000+ articles', [
      createNode('1_2', 'StaticText', 'English'),
      createNode('1_3', 'StaticText', '7,245,000+ '),
      createNode('1_4', 'StaticText', 'articles'),
    ]);

    const formatter = new SnapshotFormatter({
      root: node,
      verbose: false,
    } as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 link "English 7,245,000+ articles"\n`,
    );
  });

  it('keeps StaticText children whose combined text differs from the parent name', () => {
    const node = createNode('1_1', 'link', 'English', [
      createNode('1_2', 'StaticText', 'English'),
      createNode('1_3', 'StaticText', 'articles'),
    ]);

    const formatter = new SnapshotFormatter({
      root: node,
      verbose: false,
    } as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 link "English"
  uid=1_2 "English"
  uid=1_3 "articles"
`,
    );
  });

  it('omits redundant option attributes in text output', () => {
    const node = createNode('1_1', 'combobox', 'Language', [
      {...createNode('1_2', 'option', 'English'), value: 'English'},
      {
        ...createNode('1_3', 'option', 'Deutsch'),
        value: 'de',
        selected: true,
      },
    ]);

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 combobox "Language"
  uid=1_2 option "English"
  uid=1_3 option "Deutsch" selected value="de"
`,
    );
  });

  it('keeps long non-data url attributes in full', () => {
    const url = 'https://example.com/?q=' + 'a'.repeat(500);
    const node = {...createNode('1_1', 'link', 'Next'), url};

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 link "Next" url="${url}"\n`,
    );
    assert.deepStrictEqual(formatter.toJSON(), {
      id: '1_1',
      role: 'link',
      name: 'Next',
      url,
    });
  });

  it('truncates long data url attributes in text and JSON output', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const truncated = url.slice(0, 255) + '... <truncated>';
    const node = {...createNode('1_1', 'image', 'logo'), url};

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    assert.strictEqual(
      formatter.toString(),
      `uid=1_1 image "logo" url="${truncated}"\n`,
    );
    assert.deepStrictEqual(formatter.toJSON(), {
      id: '1_1',
      role: 'image',
      name: 'logo',
      url: truncated,
    });
  });

  it('formats a snapshot with value properties', () => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'textbox',
      name: 'textbox',
      value: 'value',
      live: 'polite',
      relevant: 'additions',
      errormessage: 'error-id',
      details: 'details-id',
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    const formatted = formatter.toString();
    assert.strictEqual(
      formatted,
      `uid=1_1 textbox "textbox" details="details-id" errormessage="error-id" live="polite" relevant="additions" value="value"
  uid=1_2 statictext "text"
`,
    );
  });

  it('formats a snapshot with boolean properties', () => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'button',
      name: 'button',
      disabled: true,
      busy: true,
      atomic: true,
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    const formatted = formatter.toString();
    assert.strictEqual(
      formatted,
      `uid=1_1 button "button" atomic busy disableable disabled
  uid=1_2 statictext "text"
`,
    );
  });

  it('formats a snapshot with checked properties', () => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'checkbox',
      name: 'checkbox',
      checked: true,
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    const formatted = formatter.toString();
    assert.strictEqual(
      formatted,
      `uid=1_1 checkbox "checkbox" checked
  uid=1_2 statictext "text"
`,
    );
  });

  it('formats a snapshot with multiple different type attributes', () => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'root',
      name: 'root',
      children: [
        {
          id: '1_2',
          role: 'button',
          name: 'button',
          focused: true,
          disabled: true,
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
        {
          id: '1_3',
          role: 'textbox',
          name: 'textbox',
          value: 'value',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
        {
          id: '1_4',
          role: 'slider',
          name: 'volume',
          valuemin: 0,
          valuemax: 100,
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    const formatted = formatter.toString();
    assert.strictEqual(
      formatted,
      `uid=1_1 root "root"
  uid=1_2 button "button" disableable disabled focusable focused
  uid=1_3 textbox "textbox" value="value"
  uid=1_4 slider "volume" valuemax="100" valuemin="0"
`,
    );
  });

  it('formats with DevTools data not included into a snapshot', t => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'checkbox',
      name: 'checkbox',
      checked: true,
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter(
      new TextSnapshot({
        snapshotId: '1',
        root: node,
        idToNode: new Map(),
        hasSelectedElement: true,
        verbose: false,
      }),
    );
    const formatted = formatter.toString();

    t.assert.snapshot(formatted);
  });

  it('does not include a note if the snapshot is already verbose', t => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'checkbox',
      name: 'checkbox',
      checked: true,
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter(
      new TextSnapshot({
        snapshotId: '1',
        root: node,
        idToNode: new Map(),
        hasSelectedElement: true,
        verbose: true,
      }),
    );
    const formatted = formatter.toString();

    t.assert.snapshot(formatted);
  });

  it('formats with DevTools data included into a snapshot', t => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'checkbox',
      name: 'checkbox',
      checked: true,
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter(
      new TextSnapshot({
        snapshotId: '1',
        root: node,
        idToNode: new Map(),
        hasSelectedElement: true,
        selectedElementUid: '1_1',
        verbose: false,
      }),
    );
    const formatted = formatter.toString();

    t.assert.snapshot(formatted);
  });

  it('formats a node with role "none" as ignored', () => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'none',
      name: '',
      children: [
        {
          id: '1_2',
          role: 'statictext',
          name: 'text',
          children: [],
          elementHandle: async (): Promise<ElementHandle<Element> | null> => {
            return null;
          },
        },
      ],
      elementHandle: async (): Promise<ElementHandle<Element> | null> => {
        return null;
      },
    };

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    const formatted = formatter.toString();
    assert.strictEqual(
      formatted,
      `uid=1_1 ignored
  uid=1_2 statictext "text"
`,
    );
  });

  it('toJSON returns expected structure', () => {
    const node: TextSnapshotNode = {
      id: '1_1',
      role: 'root',
      name: 'root',
      busy: true,
      live: 'polite',
      children: [
        {
          id: '1_2',
          role: 'button',
          name: 'button',
          disabled: true,
          children: [],
          elementHandle: async () => null,
        },
      ],
      elementHandle: async () => null,
    };

    const formatter = new SnapshotFormatter({root: node} as TextSnapshot);
    const json = formatter.toJSON();

    assert.deepStrictEqual(json, {
      id: '1_1',
      role: 'root',
      name: 'root',
      busy: true,
      live: 'polite',
      children: [
        {
          id: '1_2',
          role: 'button',
          name: 'button',
          disableable: true,
          disabled: true,
        },
      ],
    });
  });

  it('supports rootUid, maxDepth, and interactiveOnly options', () => {
    const tree = createNode('1_0', 'RootWebArea', 'Page', [
      createNode('1_1', 'generic', '', [
        createNode('1_2', 'paragraph', 'Intro'),
        createNode('1_3', 'generic', '', [
          createNode('1_4', 'button', 'Submit'),
        ]),
        createNode('1_5', 'link', 'Home', [
          createNode('1_6', 'StaticText', 'Home'),
        ]),
      ]),
    ]);

    const interactive = new SnapshotFormatter(
      {root: tree, verbose: false} as TextSnapshot,
      {interactiveOnly: true},
    );
    assert.strictEqual(
      interactive.toString(),
      `uid=1_0 RootWebArea "Page"
  uid=1_4 button "Submit"
  uid=1_5 link "Home"
`,
    );

    const subtreeDepth = new SnapshotFormatter(
      {root: tree, verbose: false} as TextSnapshot,
      {rootUid: '1_1', maxDepth: 1},
    );
    assert.strictEqual(
      subtreeDepth.toString(),
      `uid=1_1 generic
  uid=1_2 paragraph "Intro"
  uid=1_3 generic
  uid=1_5 link "Home"
`,
    );
    assert.deepStrictEqual(subtreeDepth.toJSON(), {
      id: '1_1',
      role: 'generic',
      children: [
        {id: '1_2', role: 'paragraph', name: 'Intro'},
        {id: '1_3', role: 'generic'},
        {id: '1_5', role: 'link', name: 'Home'},
      ],
    });
  });

  it('supports formsOnly and excludes normal navigation links', () => {
    const tree = createNode('1_0', 'RootWebArea', 'Checkout', [
      createNode('1_1', 'navigation', 'Nav', [
        {
          ...createNode('1_2', 'link', 'Home'),
          focused: false,
        } as TextSnapshotNode,
      ]),
      createNode('1_3', 'main', 'Main', [
        createNode('1_4', 'textbox', 'Email'),
        createNode('1_5', 'combobox', 'Country'),
        createNode('1_6', 'checkbox', 'Subscribe'),
        {
          ...createNode('1_7', 'generic', 'Custom Input'),
          editable: true,
        } as TextSnapshotNode,
        {
          ...createNode('1_8', 'generic', 'Focused Item'),
          focused: true,
        } as TextSnapshotNode,
        createNode('1_9', 'button', 'Submit'),
      ]),
    ]);

    const formatter = new SnapshotFormatter(
      {root: tree, verbose: false} as TextSnapshot,
      {formsOnly: true},
    );
    assert.strictEqual(
      formatter.toString(),
      `uid=1_0 RootWebArea "Checkout"
  uid=1_4 textbox "Email"
  uid=1_5 combobox "Country"
  uid=1_6 checkbox "Subscribe"
  uid=1_7 generic "Custom Input" editable
  uid=1_8 generic "Focused Item" focusable focused
  uid=1_9 button "Submit"
`,
    );
  });

  it('supports case-insensitive roles filter with rootUid and maxDepth and empty fallback', () => {
    const tree = createNode('1_0', 'RootWebArea', 'Page', [
      createNode('1_1', 'main', 'Main', [
        createNode('1_2', 'heading', 'Title'),
        createNode('1_3', 'link', 'Docs'),
        createNode('1_4', 'generic', '', [
          createNode('1_5', 'button', 'Save'),
          createNode('1_6', 'generic', '', [
            createNode('1_7', 'button', 'Nested'),
          ]),
        ]),
      ]),
    ]);

    const rolesFiltered = new SnapshotFormatter(
      {root: tree, verbose: false} as TextSnapshot,
      {rootUid: '1_1', maxDepth: 1, roles: ['Button', 'HEADING']},
    );
    assert.strictEqual(
      rolesFiltered.toString(),
      `uid=1_1 main "Main"
  uid=1_2 heading "Title"
  uid=1_5 button "Save"
  uid=1_7 button "Nested"
`,
    );
    assert.deepStrictEqual(rolesFiltered.toJSON(), {
      id: '1_1',
      role: 'main',
      name: 'Main',
      children: [
        {id: '1_2', role: 'heading', name: 'Title'},
        {id: '1_5', role: 'button', name: 'Save'},
        {id: '1_7', role: 'button', name: 'Nested'},
      ],
    });

    const emptyRoles = new SnapshotFormatter(
      {root: tree, verbose: false} as TextSnapshot,
      {rootUid: '1_1', roles: ['dialog']},
    );
    assert.ok(
      emptyRoles
        .toString()
        .includes('No matching nodes found for roles [dialog] under uid=1_1'),
    );
    assert.deepStrictEqual(emptyRoles.toJSON(), {
      id: '1_1',
      role: 'main',
      name: 'Main',
      empty: true,
      message:
        'No matching nodes found for roles [dialog] under uid=1_1. Retry take_snapshot without roles to inspect the full tree.',
    });

    const emptyForms = new SnapshotFormatter(
      {
        root: createNode('2_0', 'RootWebArea', 'Article', [
          createNode('2_1', 'link', 'Read'),
        ]),
        verbose: false,
      } as TextSnapshot,
      {formsOnly: true},
    );
    assert.ok(
      emptyForms
        .toString()
        .includes(
          'No matching form/action nodes found for formsOnly under uid=2_0',
        ),
    );
  });

  it('supports outlineOnly with node counts and fallback when no landmarks or headings exist', () => {
    const tree = createNode('1_0', 'RootWebArea', 'App', [
      createNode('1_1', 'navigation', 'TopNav', [
        createNode('1_2', 'link', 'Home'),
        createNode('1_3', 'link', 'About'),
      ]),
      createNode('1_4', 'main', 'Main', [
        createNode('1_5', 'heading', 'Dashboard'),
        createNode('1_6', 'form', 'SearchForm', [
          createNode('1_7', 'textbox', 'Query'),
          createNode('1_8', 'button', 'Go'),
        ]),
      ]),
    ]);

    const outline = new SnapshotFormatter(
      {root: tree, verbose: false} as TextSnapshot,
      {outlineOnly: true},
    );
    assert.strictEqual(
      outline.toString(),
      `uid=1_0 RootWebArea "App" [nodes=8]
  uid=1_1 navigation "TopNav" [nodes=2]
  uid=1_4 main "Main" [nodes=4]
    uid=1_5 heading "Dashboard" [nodes=0]
    uid=1_6 form "SearchForm" [nodes=2]
`,
    );
    assert.deepStrictEqual(outline.toJSON(), {
      id: '1_0',
      role: 'RootWebArea',
      name: 'App',
      nodeCount: 8,
      children: [
        {
          id: '1_1',
          role: 'navigation',
          name: 'TopNav',
          nodeCount: 2,
        },
        {
          id: '1_4',
          role: 'main',
          name: 'Main',
          nodeCount: 4,
          children: [
            {
              id: '1_5',
              role: 'heading',
              name: 'Dashboard',
              nodeCount: 0,
            },
            {
              id: '1_6',
              role: 'form',
              name: 'SearchForm',
              nodeCount: 2,
            },
          ],
        },
      ],
    });

    const plainTree = createNode('3_0', 'RootWebArea', 'Plain', [
      createNode('3_1', 'generic', 'Wrapper', [
        createNode('3_2', 'paragraph', 'Hello'),
      ]),
      createNode('3_3', 'button', 'OK'),
    ]);
    const fallbackOutline = new SnapshotFormatter(
      {root: plainTree, verbose: false} as TextSnapshot,
      {outlineOnly: true},
    );
    assert.strictEqual(
      fallbackOutline.toString(),
      `uid=3_0 RootWebArea "Plain" [nodes=3]
Note: No landmarks or headings found under uid=3_0. Use rootUid or omit outlineOnly for full snapshot.
  uid=3_1 generic "Wrapper" [nodes=1]
  uid=3_3 button "OK" [nodes=0]
`,
    );
    assert.deepStrictEqual(fallbackOutline.toJSON(), {
      id: '3_0',
      role: 'RootWebArea',
      name: 'Plain',
      nodeCount: 3,
      outlineFallback: true,
      children: [
        {
          id: '3_1',
          role: 'generic',
          name: 'Wrapper',
          nodeCount: 1,
        },
        {
          id: '3_3',
          role: 'button',
          name: 'OK',
          nodeCount: 0,
        },
      ],
    });
  });
});
