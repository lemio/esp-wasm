#include "wasi-compat.h"
#include <errno.h>
#include <string.h>

/* Fill the trailing XXXXXX with a counter: there's one process, so that's unique. */
char *mktemp(char *tmpl) {
  static unsigned counter;
  size_t len = strlen(tmpl);
  if (len < 6 || strcmp(tmpl + len - 6, "XXXXXX") != 0) {
    errno = EINVAL;
    tmpl[0] = '\0';
    return tmpl;
  }
  unsigned n = ++counter;
  for (int i = 1; i <= 6; i++, n /= 36)
    tmpl[len - i] = "0123456789abcdefghijklmnopqrstuvwxyz"[n % 36];
  return tmpl;
}

#define NOSYS(decl) decl { errno = ENOSYS; return -1; }
NOSYS(pid_t fork(void))
NOSYS(int execv(const char *path, char *const argv[]))
NOSYS(int execvp(const char *file, char *const argv[]))
NOSYS(pid_t wait(int *status))
NOSYS(pid_t waitpid(pid_t pid, int *status, int options))
NOSYS(int kill(pid_t pid, int sig))
NOSYS(int dup(int fd))
NOSYS(int dup2(int oldfd, int newfd))

/* WASI has no permission bits; remember the mask so callers see consistent values. */
mode_t umask(mode_t mask) {
  static mode_t current = 022;
  mode_t old = current;
  current = mask;
  return old;
}
