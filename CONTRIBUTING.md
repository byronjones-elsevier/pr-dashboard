# Contributing to PR-Dashboard

Thank you for considering contributing to PR-Dashboard! It's people like you that make PR-Dashboard such a great tool. 🎉

The following is a set of guidelines for contributing to this project. These are mostly guidelines, not rules. Use your best judgment, and feel free to propose changes to this document in a pull request.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How Can I Contribute?](#how-can-i-contribute)
  - [Reporting Bugs](#reporting-bugs)
  - [Suggesting Enhancements](#suggesting-enhancements)
  - [Your First Code Contribution](#your-first-code-contribution)
  - [Pull Requests](#pull-requests)
- [Development Setup](#development-setup)
- [Style Guidelines](#style-guidelines)
  - [Git Commit Messages](#git-commit-messages)
  - [Code Style](#code-style)
- [Additional Notes](#additional-notes)

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to [email@example.com].

## Getting Started

- Make sure you have a [GitHub account](https://github.com/signup/free)
- Fork the repository on GitHub
- Read the [README](README.md) for project overview and setup instructions

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the [issue list](https://github.com/[user]/[repo]/issues) to avoid duplicates. When you create a bug report, please include as many details as possible:

- **Use a clear and descriptive title**
- **Include your environment details** (OS, browser, version, etc.)
- **Describe the exact steps to reproduce the problem**
- **Provide specific examples** (code snippets, screenshots, etc.)
- **Describe the behavior you observed and what you expected**


### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **A clear and descriptive title**
- **A detailed description of the proposed feature**
- **Explain why this enhancement would be useful**
- **List some examples of how it would be used**

### Your First Code Contribution

Unsure where to begin? You can start by looking through these issues:

- [Good first issues](https://github.com/[user]/[repo]/labels/good%20first%20issue) - issues suitable for newcomers
- [Help wanted issues](https://github.com/[user]/[repo]/labels/help%20wanted) - issues that need extra attention

### Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code that should be tested, add tests
3. If you've changed APIs, update the documentation
4. Ensure the test suite passes
5. Make sure your code lints
6. Issue that pull request!

#### Pull Request Process

1. Update the README.md with details of changes to the interface, if applicable
2. Update the CHANGELOG.md with details of changes
3. Increase version numbers in any examples files and the README.md to the new version (following [SemVer](http://semver.org/))
4. Your PR will be reviewed by maintainers, who may request changes

## Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/[repo-name].git
cd [repo-name]

# Install dependencies
[npm install / pip install -r requirements.txt / etc.]

# Create a branch
git checkout -b feature/your-feature-name

# Run tests
[npm test / pytest / etc.]
