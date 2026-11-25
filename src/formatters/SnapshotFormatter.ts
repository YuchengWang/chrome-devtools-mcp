/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {TextSnapshot} from '../TextSnapshot.js';
import type {TextSnapshotNode} from '../types.js';
import {truncateUrl} from '../utils/text.js';

export interface SnapshotFormatOptions {
  rootUid?: string;
  maxDepth?: number;
  interactiveOnly?: boolean;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'gridcell',
  'scrollbar',
]);

export class SnapshotFormatter {
  #snapshot: TextSnapshot;
  #options: SnapshotFormatOptions;

  constructor(snapshot: TextSnapshot, options: SnapshotFormatOptions = {}) {
    this.#snapshot = snapshot;
    this.#options = options;
  }

  toString(): string {
    const chunks: string[] = [];
    const root = this.#resolveRoot();

    // Top-level content of the snapshot.
    if (
      !this.#snapshot.verbose &&
      this.#snapshot.hasSelectedElement &&
      !this.#snapshot.selectedElementUid
    ) {
      chunks.push(`Note: there is a selected element in the DevTools Elements panel but it is not included into the current a11y tree snapshot.
Get a verbose snapshot to include all elements if you are interested in the selected element.\n\n`);
    }

    chunks.push(this.#formatNode(root, 0));
    return chunks.join('');
  }

  toJSON(): object {
    return this.#nodeToJSON(this.#resolveRoot(), 0);
  }

  #resolveRoot(): TextSnapshotNode {
    const root = this.#snapshot.root;
    if (!this.#options.rootUid) {
      return root;
    }
    const found =
      this.#snapshot.idToNode?.get(this.#options.rootUid) ??
      findNodeByUid(root, this.#options.rootUid);
    if (!found) {
      throw new Error(
        `No snapshot node found with uid "${this.#options.rootUid}".`,
      );
    }
    return found;
  }

  #isInteractiveNode(node: TextSnapshotNode): boolean {
    if (node.id && node.id === this.#snapshot.selectedElementUid) {
      return true;
    }
    if (node.role && INTERACTIVE_ROLES.has(node.role)) {
      return true;
    }
    if (
      (node as unknown as Record<string, unknown>).focused !== undefined ||
      (node as unknown as Record<string, unknown>).editable === true
    ) {
      return true;
    }
    return false;
  }

  #getEffectiveChildren(node: TextSnapshotNode): TextSnapshotNode[] {
    if (!this.#options.interactiveOnly) {
      return node.children;
    }
    const result: TextSnapshotNode[] = [];
    for (const child of node.children) {
      if (this.#isInteractiveNode(child)) {
        result.push(child);
      } else {
        result.push(...this.#getEffectiveChildren(child));
      }
    }
    return result;
  }

  #formatNode(node: TextSnapshotNode, depth = 0): string {
    const chunks: string[] = [];
    const attributes = this.#getAttributes(node);
    const line =
      ' '.repeat(depth * 2) +
      attributes.join(' ') +
      (node.id && node.id === this.#snapshot.selectedElementUid
        ? ' [selected in the DevTools Elements panel]'
        : '') +
      '\n';
    chunks.push(line);

    if (
      this.#options.maxDepth !== undefined &&
      depth >= this.#options.maxDepth
    ) {
      return chunks.join('');
    }

    if (!this.#hasRedundantTextChildren(node)) {
      for (const child of this.#getEffectiveChildren(node)) {
        chunks.push(this.#formatNode(child, depth + 1));
      }
    }
    return chunks.join('');
  }

  #hasRedundantTextChildren(node: TextSnapshotNode): boolean {
    if (this.#snapshot.verbose || !node.name || node.children.length === 0) {
      return false;
    }
    let text = '';
    for (const child of node.children) {
      if (
        child.role !== 'StaticText' ||
        child.children.length !== 0 ||
        child.id === this.#snapshot.selectedElementUid
      ) {
        return false;
      }
      text += child.name ?? '';
    }
    return stripWhitespace(text) === stripWhitespace(node.name);
  }

  #nodeToJSON(node: TextSnapshotNode, depth = 0): object {
    const rawAttrs = this.#getAttributesMap(node);
    const children =
      this.#options.maxDepth !== undefined && depth >= this.#options.maxDepth
        ? []
        : this.#getEffectiveChildren(node).map(child =>
            this.#nodeToJSON(child, depth + 1),
          );
    const result: Record<string, unknown> = structuredClone(rawAttrs);
    if (children.length > 0) {
      result.children = children;
    }
    return result;
  }

  #getAttributes(serializedAXNodeRoot: TextSnapshotNode): string[] {
    const attributes: string[] = [];
    if (serializedAXNodeRoot.id) {
      attributes.push(`uid=${serializedAXNodeRoot.id}`);
    }

    if (
      serializedAXNodeRoot.role &&
      serializedAXNodeRoot.role !== 'StaticText'
    ) {
      attributes.push(
        serializedAXNodeRoot.role === 'none'
          ? 'ignored'
          : serializedAXNodeRoot.role,
      );
    }
    if (serializedAXNodeRoot.name) {
      attributes.push(`"${serializedAXNodeRoot.name}"`);
    }

    const simpleAttrs = this.#getAttributesMap(
      serializedAXNodeRoot,
      /* excludeSpecial */ true,
    );

    const isOption = serializedAXNodeRoot.role === 'option';
    for (const attr of Object.keys(serializedAXNodeRoot).sort()) {
      if (excludedAttributes.has(attr)) {
        continue;
      }

      const mapped = booleanPropertyMap[attr];
      if (
        mapped &&
        simpleAttrs[mapped] &&
        !(isOption && mapped === 'selectable')
      ) {
        attributes.push(mapped);
      }

      const val = simpleAttrs[attr];
      if (isOption && attr === 'value' && val === serializedAXNodeRoot.name) {
        continue;
      }
      if (val === true) {
        attributes.push(attr);
      } else if (typeof val === 'string' || typeof val === 'number') {
        attributes.push(`${attr}="${val}"`);
      }
    }

    return attributes;
  }

  #getAttributesMap(
    node: TextSnapshotNode,
    excludeSpecial = false,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (!excludeSpecial) {
      if (node.id) {
        result.id = node.id;
      }
      if (node.role) {
        result.role = node.role;
      }
      if (node.name) {
        result.name = node.name;
      }
    }

    // Re-implementing the exact logic from original function for #getAttributes to be safe:
    return {
      ...result,
      ...this.#extractedAttributes(node),
    };
  }

  #extractedAttributes(node: TextSnapshotNode): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const attr of Object.keys(node).sort()) {
      if (excludedAttributes.has(attr)) {
        continue;
      }
      const value = (node as unknown as Record<string, unknown>)[attr];
      if (typeof value === 'boolean') {
        if (booleanPropertyMap[attr]) {
          result[booleanPropertyMap[attr]] = true;
        }
        if (value) {
          result[attr] = true;
        }
      } else if (attr === 'url' && typeof value === 'string') {
        // Keep other URLs whole: the snapshot is their only full copy.
        result[attr] = value.startsWith('data:') ? truncateUrl(value) : value;
      } else if (typeof value === 'string' || typeof value === 'number') {
        result[attr] = value;
      }
    }
    return result;
  }
}

const booleanPropertyMap: Record<string, string> = {
  disabled: 'disableable',
  expanded: 'expandable',
  focused: 'focusable',
  selected: 'selectable',
};

const excludedAttributes = new Set([
  'id',
  'role',
  'name',
  'elementHandle',
  'children',
  'backendNodeId',
  'loaderId',
]);

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}

function findNodeByUid(
  node: TextSnapshotNode,
  uid: string,
): TextSnapshotNode | undefined {
  if (node.id === uid) {
    return node;
  }
  for (const child of node.children) {
    const found = findNodeByUid(child, uid);
    if (found) {
      return found;
    }
  }
  return undefined;
}
