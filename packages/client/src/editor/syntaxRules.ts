import { tags as t } from '@lezer/highlight';

/*
 * Syntax colors of fenced code: the --syn-* tokens in index.css, set per code theme (lib/codeTheme.ts). The source
 * view adds Markdown punctuation and URLs on top.
 */
export const syntaxRules = [
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword], color: 'rgb(var(--syn-keyword))' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'rgb(var(--syn-string))' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'rgb(var(--syn-number))' },
  { tag: [t.comment, t.meta], color: 'rgb(var(--syn-comment))', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: 'rgb(var(--syn-function))' },
  { tag: [t.typeName, t.className, t.namespace], color: 'rgb(var(--syn-type))' },
  { tag: t.tagName, color: 'rgb(var(--syn-tag))' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'rgb(var(--syn-property))' },
  { tag: t.attributeName, color: 'rgb(var(--syn-attr))' },
  { tag: t.attributeValue, color: 'rgb(var(--syn-string))' },
  { tag: [t.operator, t.derefOperator], color: 'rgb(var(--syn-operator))' },
  { tag: [t.escape, t.character], color: 'rgb(var(--syn-escape))' },
];

