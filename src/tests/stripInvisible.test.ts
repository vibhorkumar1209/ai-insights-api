import { cleanText, stripInvisible } from '../middleware/stripInvisible';

describe('stripInvisible', () => {
  it('removes the zero-width space RefractOne sent', () => {
    expect(cleanText("The Chefs'​ Warehouse")).toBe("The Chefs' Warehouse");
  });

  it('removes other invisible characters and normalizes odd spaces', () => {
    expect(cleanText('﻿Acme‌‍⁠­ Corp')).toBe('Acme Corp');
    expect(cleanText('Acme Corp Ltd')).toBe('Acme Corp Ltd');
  });

  it('leaves normal text, accents and other scripts alone', () => {
    for (const s of ['Société Générale', 'Nestlé S.A.', '株式会社日立製作所', 'Al-Futtaim', 'O\'Shaughnessy & Co.']) {
      expect(cleanText(s)).toBe(s);
    }
  });

  it('cleans nested request bodies', () => {
    const req = { body: { companyName: 'A​B', list: ['x​'], nested: { n: 1, s: '﻿y' } } };
    stripInvisible(req as never, {} as never, () => undefined);
    expect(req.body).toEqual({ companyName: 'AB', list: ['x'], nested: { n: 1, s: 'y' } });
  });
});
