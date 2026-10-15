import { describe, expect, it } from 'vitest';
import { imageFilesToDrop, imageFilesToPaste, insertAt } from './imagePaste';

const file = (type: string, name = 'f') => new File(['x'], name, { type });
const dt = (files: File[], text = '') =>
  ({ files, getData: (t: string) => (t === 'text/plain' ? text : '') }) as unknown as DataTransfer;

describe('imageFilesToPaste', () => {
  it('returns the image files of a clipboard that holds no text', () => {
    const png = file('image/png');
    expect(imageFilesToPaste(dt([png, file('application/pdf')]))).toEqual([png]);
  });
  it('returns nothing when the clipboard also has text (a spreadsheet copy), so the text pastes as usual', () => {
    expect(imageFilesToPaste(dt([file('image/png')], 'a\tb\n1\t2'))).toEqual([]);
  });
  it('returns nothing for a null clipboard or no files', () => {
    expect(imageFilesToPaste(null)).toEqual([]);
    expect(imageFilesToPaste(dt([]))).toEqual([]);
  });
});

describe('imageFilesToDrop', () => {
  it('returns the dropped image files and ignores other files', () => {
    const jpg = file('image/jpeg');
    expect(imageFilesToDrop(dt([jpg, file('text/plain')]))).toEqual([jpg]);
    expect(imageFilesToDrop(null)).toEqual([]);
  });
});

describe('insertAt', () => {
  it('replaces the selection and returns the new caret', () => {
    expect(insertAt('Some text', 4, 4, '[X]')).toEqual({ body: 'Some[X] text', caret: 7 });
    expect(insertAt('Some text', 0, 4, '[X]')).toEqual({ body: '[X] text', caret: 3 });
  });
  it('clamps a stale selection to the current text', () => {
    expect(insertAt('ab', 50, 60, 'Z')).toEqual({ body: 'abZ', caret: 3 });
  });
});
