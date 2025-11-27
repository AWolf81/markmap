# Markmap Test Server

This directory contains a simple test server for developing and testing markmap features.

## Structure

```
test_server/
├── server.js                    # Simple Node.js static file server
├── alternate_dir_feature/       # Alternate direction feature demo
│   ├── index.html              # Main demo page
│   ├── examples.js             # Example configurations
│   └── examples/               # Markdown source files
│       ├── normal.md
│       ├── manual.md
│       ├── alternate.md
│       ├── balanced.md
│       ├── mixed.md
│       └── complex.md
└── README.md                    # This file
```

## Running the Server

From the project root:

```bash
# Install dependencies (if not already done)
pnpm install

# Build the packages
pnpm build:js

# Start the test server
pnpm serve:test
```

The server will start on http://localhost:8080

## Features

- **Simple Server**: Minimal Node.js HTTP server with no external dependencies
- **Module-based Examples**: Examples are separated into individual markdown files
- **Easy to Extend**: Add new examples by:
  1. Creating a new `.md` file in `examples/`
  2. Adding an entry to `examples.js`
  3. The dropdown will automatically update

## Adding New Examples

1. Create a new markdown file in `alternate_dir_feature/examples/`:

```markdown
---
markmap:
  alternateLayout: balanced
---

# Your Example

## Section 1
- Item 1
```

2. Add it to `alternate_dir_feature/examples.js`:

```javascript
export const examples = {
  // ... existing examples
  yourExample: {
    title: 'Your Example Title',
    file: 'examples/your-example.md'
  }
};
```

3. Reload the page - it will appear in the dropdown automatically

## Server Details

The server serves:
- Main files from `test_server/alternate_dir_feature/`
- Package files from `packages/` (for built markmap libraries)

It runs on port 8080 and includes CORS headers for local development.
