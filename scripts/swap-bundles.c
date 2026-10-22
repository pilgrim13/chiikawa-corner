#include <stdio.h>
#include <errno.h>
#include <string.h>

// Both paths already exist on one volume. The running app path never disappears.
int main(int argc, char **argv) {
  if (argc != 3) return 64;
  if (renamex_np(argv[1], argv[2], RENAME_SWAP) != 0) {
    fprintf(stderr, "Bundle swap failed: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}
