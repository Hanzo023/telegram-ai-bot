# Git Setup Instructions

Since git is not currently installed on your system, follow these steps after installing git:

## Install Git

Download and install Git from: https://git-scm.com/download/win

## Initialize Repository

Once git is installed, run these commands in the project directory:

```bash
# Initialize git repository
git init

# Stage all files
git add .

# Make initial commit
git commit -m "feat: initial telegram claude bot"
```

## Verify .gitignore

The .gitignore file is configured to exclude:
- `node_modules/` (dependencies)
- `.env` (sensitive credentials)

You can verify by running:
```bash
git status
```

Make sure `.env` does NOT appear in the list of files to be committed.

## Optional: Add Remote Repository

To push to a remote repository (GitHub, GitLab, etc.):

```bash
git remote add origin <your-repository-url>
git branch -M main
git push -u origin main
```
