/* Replacement for wasi-libc's setjmp.h, which needs the wasm exception-handling
 * proposal. binutils only uses setjmp for error recovery in the disassembler:
 * setjmp returns 0 and a longjmp traps. */
#ifndef WASI_COMPAT_SETJMP_H
#define WASI_COMPAT_SETJMP_H
typedef int jmp_buf[1];
typedef int sigjmp_buf[1];
#define setjmp(env) 0
#define sigsetjmp(env, savemask) 0
#define longjmp(env, val) __builtin_trap()
#define siglongjmp(env, val) __builtin_trap()
#endif
