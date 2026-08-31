// Tests for the book-lookup providers.
//
// OpenLibrary's coverage of recent releases is thin — a 2025 hardback with a
// 979-prefix ISBN ("The Algorithm" by Jon McNeill, 9798217177530) scans fine
// and still comes back not-found. These cover the Google Books fallback that
// catches those, and the normalisation that lets one record shape serve both
// catalogues.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFunctions } from './extract.mjs';

const P = loadFunctions(
  ['gbCover', 'gbNormalize', 'genreFromSubjects'],
  // GENRE_MAP is a top-level const the extracted functions close over.
  `const GENRE_MAP={fiction:'Literary Fiction',mystery:'Mystery / Thriller',thriller:'Mystery / Thriller',history:'Nonfiction',biography:'Memoir / Biography',memoir:'Memoir / Biography',fantasy:'Fantasy','science fiction':'Science Fiction',romance:'Romance','self-help':'Self-Help',business:'Business',economics:'Business',management:'Business',entrepreneurship:'Business',poetry:'Poetry','young adult':'Young Adult'};`
);

// Shaped like a real Google Books volume for the book that prompted this.
const ALGORITHM = {
  volumeInfo: {
    title: 'The Algorithm',
    subtitle: 'The Hypergrowth Formula that Transformed Tesla, Lululemon, General Motors and SpaceX',
    authors: ['Jon McNeill'],
    publishedDate: '2025-09-02',
    pageCount: 272,
    categories: ['Business & Economics / Leadership'],
    industryIdentifiers: [{ type: 'ISBN_13', identifier: '9798217177530' }],
    imageLinks: {
      smallThumbnail: 'http://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=5&edge=curl',
      thumbnail: 'http://books.google.com/books/content?id=X&printsec=frontcover&img=1&zoom=1&edge=curl'
    }
  }
};

test('a Google Books volume normalises to the shared record shape', () => {
  const r = P.gbNormalize(ALGORITHM);
  assert.equal(r.title,
    'The Algorithm: The Hypergrowth Formula that Transformed Tesla, Lululemon, General Motors and SpaceX');
  assert.deepEqual(r.authors, ['Jon McNeill']);
  assert.equal(r.year, 2025);
  assert.equal(r.pages, 272);
  assert.equal(r.isbn, '9798217177530', '979-prefix ISBNs survive normalisation');
  assert.equal(r.source, 'google');
});

test('cover URLs are upgraded to https and stripped of the page curl', () => {
  const url = P.gbNormalize(ALGORITHM).cover;
  assert.ok(url.startsWith('https://'), 'http:// would be blocked as mixed content on the live page');
  assert.ok(!url.includes('edge=curl'));
});

test('a volume with no images yields an empty cover, not undefined', () => {
  assert.equal(P.gbCover({ title: 'x' }), '');
  assert.equal(P.gbCover(null), '');
});

test('malformed volumes are dropped rather than crashing the map', () => {
  assert.equal(P.gbNormalize(null), null);
  assert.equal(P.gbNormalize({}), null);
  assert.equal(P.gbNormalize({ volumeInfo: {} }), null, 'a volume with no title is not a result');
});

test('a volume missing optional fields still normalises', () => {
  const r = P.gbNormalize({ volumeInfo: { title: 'Bare' } });
  assert.deepEqual(r.authors, []);
  assert.equal(r.year, null);
  assert.equal(r.pages, null);
  assert.equal(r.isbn, '');
  assert.equal(r.cover, '');
});

test('ISBN-10 is used when there is no ISBN-13, and hyphens are stripped', () => {
  const r = P.gbNormalize({ volumeInfo: { title: 'T', industryIdentifiers: [{ type: 'ISBN_10', identifier: '0-441-01359-0' }] } });
  assert.equal(r.isbn, '0441013590');
});

test('genre mapping works across both catalogues subject shapes', () => {
  // Google Books gives plain strings; OpenLibrary gives strings or {name}.
  assert.equal(P.genreFromSubjects(['Business & Economics / Leadership']), 'Business');
  assert.equal(P.genreFromSubjects([{ name: 'Science Fiction' }]), 'Science Fiction');
  assert.equal(P.genreFromSubjects(['Nothing familiar']), '');
  assert.equal(P.genreFromSubjects([]), '');
  assert.equal(P.genreFromSubjects(undefined), '');
});

test('a more specific genre wins over a substring of it', () => {
  // These matched 'fiction' first and every one landed in Literary Fiction.
  assert.equal(P.genreFromSubjects(['Science Fiction']), 'Science Fiction');
  assert.equal(P.genreFromSubjects(['Juvenile Fiction / Young Adult']), 'Young Adult');
  assert.equal(P.genreFromSubjects(['Fiction / Literary']), 'Literary Fiction', 'plain fiction still maps');
});

test('the first recognised subject wins', () => {
  assert.equal(P.genreFromSubjects(['Unmapped topic', 'Poetry', 'Romance']), 'Poetry');
});
