import {
  describeError as sharedDescribeError,
  redactUrls as sharedRedactUrls,
} from '../config/redact';
import { describeError, redactUrls } from './decode';

// The redaction itself is specified in ../config/redact.spec.ts.
describe('the keeper redaction helpers', () => {
  it('are the shared ones, so the keeper and the indexer redact alike', () => {
    expect(redactUrls).toBe(sharedRedactUrls);
    expect(describeError).toBe(sharedDescribeError);
  });
});
