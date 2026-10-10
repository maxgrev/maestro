MD4C 0.5.2, vendored from https://github.com/mity/md4c/tree/release-0.5.2/src.
MIT license: LICENSE.md.

Local change: initialize `label_contents_line_index` in
`md_is_link_reference_definition` to satisfy Xtensa GCC 15's
`-Werror=maybe-uninitialized` check. Parser behavior is otherwise unchanged.
