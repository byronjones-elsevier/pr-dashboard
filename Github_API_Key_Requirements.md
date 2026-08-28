# Required GitHub API Permissions

## The application makes the following GitHub API calls, which require these scopes:

1. Search API (/search/issues)
 - Used for: Fetching open pull requests for selected team members
 - Required scope: public_repo (for public repositories) or repo (for private repositories)
 - Called in: fetch_prs() command
 - Details: Makes 3 search calls per team member to find:
   - Open PRs authored by the user
   - PRs with "changes_requested" reviews
   - PRs with "approved" reviews
2. Team Members List (GET /orgs/{org}/teams/{team-slug}/members)
 - Required scope: read:org (minimum) or admin:org (for private teams)
 - Called in: add_group() command
 - Details: Fetches the roster of a GitHub team to populate the members list
3. Pull Request Reviews (POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews)
 - Required scope: repo or public_repo
 - Called in: approve_pr() command
 - Details: Submits a review approval on a PR
4. Pull Request Updates (PATCH /repos/{owner}/{repo}/pulls/{pull_number})
 - Required scope: repo or public_repo
 - Called in: close_pr() and close_pr_and_delete_branch() commands
 - Details: Closes a pull request
5. Branch Deletion (DELETE /repos/{owner}/{repo}/git/refs/heads/{branch})
 - Required scope: repo or public_repo
 - Called in: close_pr_and_delete_branch() command
 - Details: Deletes the branch associated with a PR
6. Rate Limit Status (GET /rate_limit)
 - Required scope: Any authenticated request
 - Called in: fetch_rate_limit() command
 - Details: Checks current rate limit consumption (no special permissions needed)
7. PR Details (GET /repos/{owner}/{repo}/pulls/{pull_number})
 - Required scope: repo or public_repo
 - Called in: close_pr_and_delete_branch() command
 - Details: Retrieves PR metadata to extract the branch name

## Recommended Scopes for the API Token

### For public repositories only:

public_repo
- read:org

For public and private repositories:
 - repo (full control of private and public repositories)
 - read:org (read organization teams)

Minimum recommended scope combination:

- repo (grants access to public and private repositories needed for PRs, reviews, and branch management)
- read:org (allows reading team membership for group imports)

The token should not require admin:org or admin:repo unless managing private teams or repository administration features, as the application only reads team members and performs standard PR/review operations.
