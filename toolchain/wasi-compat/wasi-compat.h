/* POSIX functions wasi-libc lacks but binutils references. Force-included with
 * -include. None of them is reached when ld just links files. */
#ifndef WASI_COMPAT_H
#define WASI_COMPAT_H
#ifdef __wasi__
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
char *mktemp(char *tmpl);
pid_t fork(void);
int execv(const char *path, char *const argv[]);
int execvp(const char *file, char *const argv[]);
pid_t wait(int *status);
pid_t waitpid(pid_t pid, int *status, int options);
int kill(pid_t pid, int sig);
int pipe(int fds[2]);
int dup(int fd);
int dup2(int oldfd, int newfd);
mode_t umask(mode_t mask);
#ifdef __cplusplus
}
#endif
#endif
#endif
