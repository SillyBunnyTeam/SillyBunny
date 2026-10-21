#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fail(int error)
{
    fprintf(stderr, "lorum ipsum %d\n", error ? error : EIO);
    return 127;
}

int main(int argc, char **argv)
{
    if (argc < 1 || !argv || !argv[0])
        return fail(EINVAL);
    const char *name = strrchr(argv[0], '/');
    name = name ? name + 1 : argv[0];
    const char *key;
    if (!strcmp(name, "npm") || !strcmp(name, "libnpm.so"))
        key = "SILLYBUNNY_ANDROID_NPM_CLI";
    else if (!strcmp(name, "npx") || !strcmp(name, "libnpx.so"))
        key = "SILLYBUNNY_ANDROID_NPX_CLI";
    else
        return fail(EINVAL);
    const char *cli = getenv(key);
    if (!cli || !*cli)
        return fail(EINVAL);

    char node[PATH_MAX];
    ssize_t length = readlink("/proc/self/exe", node, sizeof(node));
    if (length < 0)
        return fail(errno);
    if ((size_t)length >= sizeof(node))
        return fail(ENAMETOOLONG);
    node[length] = '\0';
    char *slash = strrchr(node, '/');
    if (!slash)
        return fail(EINVAL);
    if ((size_t)(slash - node) + sizeof("/libnode.so") > sizeof(node))
        return fail(ENAMETOOLONG);
    memcpy(slash, "/libnode.so", sizeof("/libnode.so"));

    char **args = calloc((size_t)argc + 2, sizeof(*args));
    if (!args)
        return fail(ENOMEM);
    args[0] = node;
    args[1] = (char *)cli;
    for (int i = 1; i < argc; ++i)
        args[i + 1] = argv[i];
    execv(node, args);
    int error = errno;
    free(args);
    return fail(error);
}
