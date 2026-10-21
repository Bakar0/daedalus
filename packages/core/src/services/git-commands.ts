import { standardExecutableFallbacks } from "@daedalus/platform";

// Where to find `gh`, and the environment for every networked `git` call,
// shared by the workspace content modules. They live in a module of their own
// so none of those modules imports another for a constant.

export const GH_EXECUTABLE_FALLBACKS = standardExecutableFallbacks("gh");

export const GIT_NETWORK_ENVIRONMENT = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_SSH_COMMAND: "ssh -oBatchMode=yes",
};
