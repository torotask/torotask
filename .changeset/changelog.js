/**
 * MIT License
 *
 * Copyright (c) Hey API
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { getInfo, getInfoFromPullRequest } from '@changesets/get-github-info';

const SKIPPED_USERS = ['benosman'];

/**
 * @returns {string}
 */
function getRepo() {
  return 'torotask/torotask';
}

/** @type {import("@changesets/types").ChangelogFunctions} */
export default {
  getDependencyReleaseLine: async (_, dependenciesUpdated) => {
    if (!dependenciesUpdated.length) {
      return '';
    }

    const list = dependenciesUpdated.map((dependency) => `  - ${dependency.name}@${dependency.newVersion}`);

    return ['### Updated Dependencies:', ...list].join('\n');
  },
  getReleaseLine: async (changeset) => {
    const repo = getRepo();

    /** @type number | undefined */
    let prFromSummary;
    /** @type string | undefined */
    let commitFromSummary;
    /** @type string[] */
    const usersFromSummary = [];

    // Remove PR, commit, author/user lines from summary
    const replacedChangelog = changeset.summary
      .replace(/^\s*(?:pr|pull|pull\s+request):\s*#?(\d+)/im, (_, pr) => {
        const num = Number(pr);
        if (!Number.isNaN(num)) {
          prFromSummary = num;
        }
        return '';
      })
      .replace(/^\s*commit:\s*([^\s]+)/im, (_, commit) => {
        commitFromSummary = commit;
        return '';
      })
      .replace(/^\s*(?:author|user):\s*@?([^\s]+)/gim, (_, user) => {
        usersFromSummary.push(user);
        return '';
      })
      .trim();

    let author;
    const links = await (async () => {
      if (prFromSummary !== undefined) {
        const info = await getInfoFromPullRequest({
          pull: prFromSummary,
          repo,
        });
        author = info.user;
        let { links } = info;
        if (commitFromSummary) {
          const shortCommitId = commitFromSummary.slice(0, 7);
          links = {
            ...links,
            commit: `[\`${shortCommitId}\`](https://github.com/${repo}/commit/${commitFromSummary})`,
          };
        }
        return links;
      }
      const commitToFetchFrom = commitFromSummary || changeset.commit;
      if (commitToFetchFrom) {
        const info = await getInfo({ commit: commitToFetchFrom, repo });
        author = info.user;
        let { links } = info;
        const shortCommitId = commitToFetchFrom.slice(0, 7);
        links = {
          ...links,
          commit: `[\`${shortCommitId}\`](https://github.com/${repo}/commit/${commitToFetchFrom})`,
        };
        return links;
      }
      return {
        commit: null,
        pull: null,
        user: null,
      };
    })();

    const users = usersFromSummary.length
      ? usersFromSummary
          .map((userFromSummary) => `[@${userFromSummary}](https://github.com/${userFromSummary})`)
          .join(', ')
      : links.user;

    const authors = usersFromSummary.length ? usersFromSummary : author ? [author] : [];

    const showAuthor = authors.length > 0 && !authors.every((user) => SKIPPED_USERS.includes(user));

    const metadata = [
      links.pull === null ? '' : ` (${links.pull})`,
      links.commit === null ? '' : ` (${links.commit})`,
      users !== null && showAuthor ? ` by ${users}` : '',
    ].join('');

    // Split summary into first line and the rest
    const [firstLine, ...rest] = replacedChangelog.split('\n');
    const restSummary = rest.join('\n').trim();

    // No code block conversion: preserve original triple backtick code blocks and indentation
    let releaseLine = `\n- ${firstLine}${metadata}`;
    if (restSummary) {
      releaseLine += '\n\n' + restSummary;
    }
    return releaseLine;
  },
};
