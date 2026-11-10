#define _GNU_SOURCE
#include <errno.h>
#include <linux/capability.h>
#include <stdio.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int refuse(const char *step) {
    fprintf(stderr, "PGC harness startup isolation failed: %s\n", step);
    return 1;
}

int main(void) {
    uid_t real, effective, saved;
    if (getresuid(&real, &effective, &saved) != 0 ||
        real == 0 || effective == 0 || saved == 0 || setfsuid((uid_t)-1) == 0) {
        return refuse("non-root UID");
    }

    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0 ||
        prctl(PR_CAP_AMBIENT, (unsigned long)PR_CAP_AMBIENT_CLEAR_ALL, 0L, 0L, 0L) != 0) {
        return refuse("no_new_privs or ambient capabilities");
    }

    // Use the running kernel's capability range. Keep CAP_SETPCAP until
    // every existing bounding bit has been dropped, then clear all other sets.
    unsigned long count = 0;
    for (;; ++count) {
        int present = prctl(PR_CAPBSET_READ, count, 0L, 0L, 0L);
        if (present < 0) {
            if (errno == EINVAL && count != 0) break;
            return refuse("read capability bounding set");
        }
        if (present != 0 && prctl(PR_CAPBSET_DROP, count, 0L, 0L, 0L) != 0) {
            return refuse("drop capability bounding set");
        }
    }

    struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
    struct __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3] = {{0}};
    if (syscall(SYS_capset, &header, data) != 0 || syscall(SYS_capget, &header, data) != 0) {
        return refuse("clear process capabilities");
    }
    for (unsigned int i = 0; i < _LINUX_CAPABILITY_U32S_3; ++i) {
        if (data[i].effective || data[i].permitted || data[i].inheritable) {
            return refuse("verify process capability sets");
        }
    }
    for (unsigned long cap = 0; cap < count; ++cap) {
        if (prctl(PR_CAPBSET_READ, cap, 0L, 0L, 0L) != 0 ||
            prctl(PR_CAP_AMBIENT, (unsigned long)PR_CAP_AMBIENT_IS_SET, cap, 0L, 0L) != 0) {
            return refuse("verify bounding or ambient capabilities");
        }
    }
    if (prctl(PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L) != 1) {
        return refuse("verify no_new_privs");
    }

    char *const args[] = { "/usr/local/bin/node", "--disable-sigusr1", "/opt/harness/runtime.mjs", NULL };
    execv(args[0], args);
    return refuse("exec runtime");
}
