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
  roles?: string[];
  formsOnly?: boolean;
  outlineOnly?: boolean;
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

const FORM_CONTROL_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'button',
  'checkbox',
  'radio',
  'switch',
  'spinbutton',
  'slider',
]);

const OUTLINE_ROLES = new Set([
  'rootwebarea',
  'main',
  'navigation',
  'form',
  'dialog',
  'alertdialog',
  'region',
  'banner',
  'contentinfo',
  'search',
  'complementary',
  'heading',
]);

export class SnapshotFormatter {
  #snapshot: TextSnapshot;
  #options: SnapshotFormatOptions;
  #roleFilter?: Set<string>;

  constructor(snapshot: TextSnapshot, options: SnapshotFormatOptions = {}) {
    this.#snapshot = snapshot;
    this.#options = options;
    if (options.roles && options.roles.length > 0) {
      const normalized = options.roles
        .map(role => role.trim().toLowerCase())
        .filter(Boolean);
      if (normalized.length > 0) {
        this.#roleFilter = new Set(normalized);
      }
    }
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

    const emptyMessage = this.#getEmptyFilterMessage(root);
    if (emptyMessage) {
      chunks.push(emptyMessage);
      return chunks.join('');
    }

    chunks.push(this.#formatNode(root, 0));
    if (this.#isOutlineFallback(root)) {
      chunks.push(this.#formatOutlineFallback(root));
    }
    return chunks.join('');
  }

  toJSON(): object {
    const root = this.#resolveRoot();
    const emptyMessage = this.#getEmptyFilterMessage(root);
    if (emptyMessage) {
      return {
        ...this.#getAttributesMap(root),
        empty: true,
        message: emptyMessage.trim(),
      };
    }
    if (this.#isOutlineFallback(root)) {
      const result: Record<string, unknown> = {
        ...this.#getAttributesMap(root),
        nodeCount: countDescendants(root),
        outlineFallback: true,
      };
      if (
        (this.#options.maxDepth === undefined || this.#options.maxDepth > 0) &&
        root.children.length > 0
      ) {
        result.children = root.children
          .filter(child => child.role !== 'StaticText')
          .map(child => ({
            ...this.#getAttributesMap(child),
            nodeCount: countDescendants(child),
          }));
      }
      return result;
    }
    return this.#nodeToJSON(root, 0);
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

  #hasNodeFilter(): boolean {
    return Boolean(
      this.#options.outlineOnly ||
        this.#roleFilter ||
        this.#options.formsOnly ||
        this.#options.interactiveOnly,
    );
  }

  #matchesFilter(node: TextSnapshotNode): boolean {
    if (this.#options.outlineOnly) {
      return Boolean(node.role && OUTLINE_ROLES.has(node.role.toLowerCase()));
    }
    if (this.#roleFilter) {
      if (!node.role) {
        return false;
      }
      const normalizedRole =
        node.role === 'none' ? 'ignored' : node.role.toLowerCase();
      return (
        this.#roleFilter.has(node.role.toLowerCase()) ||
        this.#roleFilter.has(normalizedRole)
      );
    }
    if (this.#options.formsOnly) {
      if (node.id && node.id === this.#snapshot.selectedElementUid) {
        return true;
      }
      if (node.role && FORM_CONTROL_ROLES.has(node.role.toLowerCase())) {
        return true;
      }
      const record = node as unknown as Record<string, unknown>;
      return record.editable === true || record.focused === true;
    }
    if (this.#options.interactiveOnly) {
      return this.#isInteractiveNode(node);
    }
    return true;
  }

  #getEmptyFilterMessage(root: TextSnapshotNode): string | undefined {
    if (!this.#roleFilter && !this.#options.formsOnly) {
      return undefined;
    }
    if (this.#matchesFilter(root)) {
      return undefined;
    }
    if (this.#getEffectiveChildren(root).length > 0) {
      return undefined;
    }
    const target = root.id ? `uid=${root.id}` : 'root';
    if (this.#roleFilter && this.#options.roles) {
      return `No matching nodes found for roles [${this.#options.roles.join(', ')}] under ${target}. Retry take_snapshot without roles to inspect the full tree.\n`;
    }
    return `No matching form/action nodes found for formsOnly under ${target}. Retry take_snapshot without formsOnly (or with outlineOnly: true) to inspect the full tree.\n`;
  }

  #isOutlineFallback(root: TextSnapshotNode): boolean {
    if (!this.#options.outlineOnly) {
      return false;
    }
    return this.#getEffectiveChildren(root).length === 0;
  }

  #formatOutlineFallback(root: TextSnapshotNode): string {
    const target = root.id ? `uid=${root.id}` : 'root';
    const lines: string[] = [
      `Note: No landmarks or headings found under ${target}. Use rootUid or omit outlineOnly for full snapshot.\n`,
    ];
    if (this.#options.maxDepth !== undefined && this.#options.maxDepth <= 0) {
      return lines.join('');
    }
    for (const child of root.children) {
      if (child.role === 'StaticText') {
        continue;
      }
      const attributes = this.#getAttributes(child);
      lines.push(
        `  ${attributes.join(' ')} [nodes=${countDescendants(child)}]\n`,
      );
    }
    return lines.join('');
  }

  #getEffectiveChildren(node: TextSnapshotNode): TextSnapshotNode[] {
    if (!this.#hasNodeFilter()) {
      return node.children;
    }
    const result: TextSnapshotNode[] = [];
    for (const child of node.children) {
      if (this.#matchesFilter(child)) {
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
    const nodeCountSuffix = this.#options.outlineOnly
      ? ` [nodes=${countDescendants(node)}]`
      : '';
    const line =
      ' '.repeat(depth * 2) +
      attributes.join(' ') +
      nodeCountSuffix +
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
    if (this.#options.outlineOnly) {
      result.nodeCount = countDescendants(node);
    }
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

function countDescendants(node: TextSnapshotNode): number {
  let count = 0;
  for (const child of node.children) {
    count += 1 + countDescendants(child);
  }
  return count;
}
