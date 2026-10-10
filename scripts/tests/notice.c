#include "maestro_notice.h"
#include <assert.h>
int main(void) {
    maestro_notice_t n = {0};
    assert(!maestro_notice_due(&n,1000,false,1));
    assert(!maestro_notice_due(&n,2000,false,2)); // Simultaneous agents coalesce.
    assert(!maestro_notice_due(&n,60000,false,2)); // Long speech never interrupted.
    assert(!maestro_notice_due(&n,61000,true,2));
    assert(!maestro_notice_due(&n,62499,true,2));
    assert(maestro_notice_due(&n,62500,true,2));
    n.alerted=2; // Acknowledgement in flight or lost: no second vibration.
    assert(!maestro_notice_due(&n,70000,true,2));
    assert(!maestro_notice_due(&n,71000,true,3)); // Later arrival is separate.
    assert(maestro_notice_due(&n,73000,true,3));
    n.alerted=3;
    assert(!maestro_notice_due(&n,74000,true,0)); // Reading cleared the batch.
    assert(!maestro_notice_due(&n,75000,false,4));
    assert(!maestro_notice_due(&n,90000,false,4)); // Reading is also not quiet.
    assert(!maestro_notice_due(&n,91000,true,4));
    assert(maestro_notice_due(&n,93000,true,4));
    return 0;
}
