import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The canvas identity columns are uuid, and the Data API binds every
// stringValue as text: Postgres refuses `uuid = text` and a text VALUES
// entry for a uuid column ("column document_id is of type uuid but
// expression is of type text"), so each :document needs CAST(... AS uuid).
// The mocked-Aurora tests never reach the SQL, which is how every draft
// creation failed 503 on the deployed stack.
const files = ['document-mapping.ts', 'document-proposals.ts', 'document-comment-import.ts'];

describe('SQL against the uuid document_id columns casts its bind', () => {
  for (const file of files) {
    it(file, () => {
      const source = readFileSync(join(__dirname, '..', file), 'utf8');
      const sql = source.match(/`[^`]*assessment_document_(?:mappings|proposals|comment_imports)[^`]*`/g) ?? [];
      expect(sql.length).toBeGreaterThan(0);
      for (const statement of sql) {
        const bare = statement.replace(/CAST\(:document AS uuid\)/g, '').match(/:document\b/g);
        expect({ statement: statement.slice(0, 120), bare }).toEqual({ statement: statement.slice(0, 120), bare: null });
      }
    });
  }
});
