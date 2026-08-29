# Agent notes

## Deployments

- Never deploy application or infrastructure changes directly from a local agent session.
- All deployments, especially production deployments, must run through the repository's existing CI/CD pipeline.
- Prepare, test, commit, and push changes so that the pipeline performs the deployment. Do not invoke CDK deploy, direct Lambda updates, or equivalent deployment commands locally.

