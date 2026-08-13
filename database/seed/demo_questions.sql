-- demo_questions.sql
--
-- Reference data: the syllabus tree and a starter question bank. This is not user data,
-- so it is safe to run on any environment, and safe to run twice -- every insert ends in
-- ON CONFLICT DO NOTHING and every id is fixed, so re-running changes nothing.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/seed/demo_questions.sql
--
-- Id scheme, so the rows are easy to recognise while debugging:
--   a0000000-...  subjects
--   b0000000-...  topics
--   c0000000-...  questions
--
-- Enough breadth for the adaptive engine to have real choices: three subjects, thirteen
-- topics, and questions at all three difficulties in every type (mcq, msq, numeric).

begin;

-- ---------------------------------------------------------------------------
-- Subjects
-- ---------------------------------------------------------------------------
insert into public.topics (id, parent_id, name, weight, sort_order) values
    ('a0000000-0000-4000-8000-000000000001', null, 'Data Structures & Algorithms', 2.00, 1),
    ('a0000000-0000-4000-8000-000000000002', null, 'Database Systems',             1.50, 2),
    ('a0000000-0000-4000-8000-000000000003', null, 'Quantitative Aptitude',        1.00, 3)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Topics
-- ---------------------------------------------------------------------------
insert into public.topics (id, parent_id, name, weight, sort_order) values
    -- Data Structures & Algorithms
    ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'Arrays & Strings',    1.00, 1),
    ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'Linked Lists',        1.00, 2),
    ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'Stacks & Queues',     1.00, 3),
    ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'Trees',               1.50, 4),
    ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'Sorting',             1.25, 5),
    ('b0000000-0000-4000-8000-000000000006', 'a0000000-0000-4000-8000-000000000001', 'Time Complexity',     1.75, 6),
    -- Database Systems
    ('b0000000-0000-4000-8000-000000000007', 'a0000000-0000-4000-8000-000000000002', 'ER Modelling',        1.00, 1),
    ('b0000000-0000-4000-8000-000000000008', 'a0000000-0000-4000-8000-000000000002', 'Normalisation',       1.75, 2),
    ('b0000000-0000-4000-8000-000000000009', 'a0000000-0000-4000-8000-000000000002', 'SQL Queries',         1.50, 3),
    ('b0000000-0000-4000-8000-00000000000a', 'a0000000-0000-4000-8000-000000000002', 'Transactions & ACID', 1.25, 4),
    ('b0000000-0000-4000-8000-00000000000b', 'a0000000-0000-4000-8000-000000000002', 'Indexing',            1.00, 5),
    -- Quantitative Aptitude
    ('b0000000-0000-4000-8000-00000000000c', 'a0000000-0000-4000-8000-000000000003', 'Percentages',         1.00, 1),
    ('b0000000-0000-4000-8000-00000000000d', 'a0000000-0000-4000-8000-000000000003', 'Ratio & Proportion',  1.00, 2),
    ('b0000000-0000-4000-8000-00000000000e', 'a0000000-0000-4000-8000-000000000003', 'Probability',         1.25, 3),
    ('b0000000-0000-4000-8000-00000000000f', 'a0000000-0000-4000-8000-000000000003', 'Speed, Time & Distance', 1.00, 4)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Questions
-- ---------------------------------------------------------------------------
-- correct_answer shapes:
--   mcq/msq  a JSON array of zero-based option indexes
--   numeric  {"value": <number>, "tol": <allowed difference>}

insert into public.questions
    (id, topic_id, question_type, body, options, correct_answer, explanation, difficulty, marks, is_verified)
values

-- ---- Arrays & Strings ----
('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'mcq',
 'What is the time complexity of reading an element from a fixed-size array when you already know its index?',
 array['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], '[0]'::jsonb,
 'Array elements sit in one continuous block of memory, so the address is found by arithmetic on the index. The work does not grow with the size of the array.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'mcq',
 'You must insert a new element at the beginning of an array that is already full to capacity minus one. What dominates the cost?',
 array['Nothing, it is constant time', 'Shifting every existing element one place right', 'Sorting the array afterwards', 'Recomputing the array length'],
 '[1]'::jsonb,
 'Every element after the insertion point has to move to make room, so the cost grows with the number of elements already stored.',
 'easy', 1, true),

-- ---- Linked Lists ----
('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000002', 'mcq',
 'In a singly linked list with no tail pointer, what is the worst-case time to append a node at the end?',
 array['O(1)', 'O(log n)', 'O(n)', 'O(n squared)'], '[2]'::jsonb,
 'Without a tail pointer the only way to reach the last node is to walk from the head, visiting every node once.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000002', 'msq',
 'Which statements are true when comparing a singly linked list with a dynamic array? Select all that apply.',
 array['The linked list can insert at the front in constant time',
       'The linked list supports reading the k-th element in constant time',
       'The linked list uses extra memory for pointers',
       'The array guarantees its elements are contiguous in memory'],
 '[0, 2, 3]'::jsonb,
 'Front insertion is a pointer change, so constant. Reading the k-th element needs a walk, so not constant. Each node stores at least one pointer, which is the memory overhead. Arrays are contiguous by definition.',
 'medium', 2, true),

-- ---- Stacks & Queues ----
('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000003', 'mcq',
 'Which structure is the natural fit for checking whether the brackets in an expression are balanced?',
 array['Queue', 'Stack', 'Min-heap', 'Hash table'], '[1]'::jsonb,
 'The bracket that opened most recently must close first, which is exactly last-in-first-out behaviour.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000006', 'b0000000-0000-4000-8000-000000000003', 'mcq',
 'A queue is implemented with two stacks. What is the amortised cost of one dequeue operation?',
 array['O(1)', 'O(log n)', 'O(n)', 'O(n squared)'], '[0]'::jsonb,
 'Each element is moved from the inbox stack to the outbox stack at most once across its lifetime, so the cost averages out to constant per operation even though a single dequeue may move many elements.',
 'hard', 2, true),

-- ---- Trees ----
('c0000000-0000-4000-8000-000000000007', 'b0000000-0000-4000-8000-000000000004', 'mcq',
 'Which traversal of a binary search tree visits the keys in non-decreasing order?',
 array['Inorder', 'Preorder', 'Postorder', 'Level order'], '[0]'::jsonb,
 'Inorder visits the left subtree, then the node, then the right subtree. Since every left key is smaller and every right key is larger, the keys come out sorted.',
 'medium', 1, true),

('c0000000-0000-4000-8000-000000000008', 'b0000000-0000-4000-8000-000000000004', 'mcq',
 'Keys are inserted into a binary search tree in strictly increasing order. What is the worst-case search time in the resulting tree?',
 array['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], '[2]'::jsonb,
 'Every key is larger than the last, so each node gets only a right child. The tree degenerates into a list and searching walks the whole chain.',
 'medium', 2, true),

('c0000000-0000-4000-8000-000000000009', 'b0000000-0000-4000-8000-000000000004', 'numeric',
 'A binary tree is perfectly balanced and completely filled. It has 4 levels, counting the root as level 1. How many nodes does it contain?',
 null, '{"value": 15, "tol": 0}'::jsonb,
 'Each level doubles: 1 + 2 + 4 + 8. A completely filled tree of h levels holds 2^h - 1 nodes, which is 15 for h = 4.',
 'medium', 2, true),

-- ---- Sorting ----
('c0000000-0000-4000-8000-00000000000a', 'b0000000-0000-4000-8000-000000000005', 'mcq',
 'Which sorting algorithm has O(n log n) worst-case time and is also stable?',
 array['Quick sort', 'Heap sort', 'Merge sort', 'Selection sort'], '[2]'::jsonb,
 'Merge sort always splits in half, giving O(n log n) even in the worst case, and a careful merge keeps equal elements in their original order. Quick sort degrades to O(n squared) in the worst case, and heap sort is not stable.',
 'medium', 2, true),

('c0000000-0000-4000-8000-00000000000b', 'b0000000-0000-4000-8000-000000000005', 'msq',
 'Which of these sorting algorithms decide order by comparing elements with each other? Select all that apply.',
 array['Merge sort', 'Counting sort', 'Quick sort', 'Radix sort'], '[0, 2]'::jsonb,
 'Merge sort and quick sort both work by comparing pairs of elements. Counting sort and radix sort instead use the values themselves as positions or digits, which is why they can beat the comparison lower bound.',
 'medium', 2, true),

('c0000000-0000-4000-8000-00000000000c', 'b0000000-0000-4000-8000-000000000005', 'mcq',
 'An already sorted array is given to an insertion sort. What is the running time?',
 array['O(1)', 'O(n)', 'O(n log n)', 'O(n squared)'], '[1]'::jsonb,
 'Each element is compared once with the one before it, finds it is already in place, and no shifting happens. That is a single pass.',
 'easy', 1, true),

-- ---- Time Complexity ----
('c0000000-0000-4000-8000-00000000000d', 'b0000000-0000-4000-8000-000000000006', 'mcq',
 'Two loops are nested, and each runs n times. What is the tightest upper bound on the total work?',
 array['O(n)', 'O(n log n)', 'O(n squared)', 'O(2 to the power n)'], '[2]'::jsonb,
 'The inner loop runs n times for each of the n outer iterations, so the body executes n times n times.',
 'easy', 1, true),

('c0000000-0000-4000-8000-00000000000e', 'b0000000-0000-4000-8000-000000000006', 'numeric',
 'An algorithm halves its input on every step and stops when one element is left. Starting from 256 elements, how many halving steps does it take?',
 null, '{"value": 8, "tol": 0}'::jsonb,
 '256 halves down through 128, 64, 32, 16, 8, 4, 2, 1 - eight steps. This is log base 2 of 256, which is why such algorithms are called logarithmic.',
 'medium', 2, true),

('c0000000-0000-4000-8000-00000000000f', 'b0000000-0000-4000-8000-000000000006', 'mcq',
 'Algorithm A runs in O(n) and algorithm B runs in O(log n). For very large n, which claim is safe?',
 array['A is always faster in practice',
       'B grows more slowly as n increases',
       'They are equivalent because both are polynomial',
       'B uses less memory'],
 '[1]'::jsonb,
 'Big-O describes growth, not wall-clock speed on a particular machine or input size, and it says nothing about memory. All that follows is that B''s work grows more slowly.',
 'hard', 2, true),

-- ---- ER Modelling ----
('c0000000-0000-4000-8000-000000000010', 'b0000000-0000-4000-8000-000000000007', 'mcq',
 'In a standard ER diagram, a rectangle drawn with a double outline represents which of these?',
 array['A weak entity', 'A strong entity', 'A relationship', 'A derived attribute'], '[0]'::jsonb,
 'A weak entity cannot be identified by its own attributes alone and depends on an owner entity, and the double outline marks that dependency.',
 'medium', 1, true),

('c0000000-0000-4000-8000-000000000011', 'b0000000-0000-4000-8000-000000000007', 'mcq',
 'An entity type has a multi-valued attribute. What is the usual way to map it to relational tables?',
 array['Store the values separated by commas in one column',
       'Create a separate table keyed by the entity key plus the value',
       'Add several columns, one per possible value',
       'Drop the attribute, as it cannot be represented'],
 '[1]'::jsonb,
 'A separate table keeps each value in its own row, which preserves first normal form and does not guess how many values there might be.',
 'medium', 2, true),

-- ---- Normalisation ----
('c0000000-0000-4000-8000-000000000012', 'b0000000-0000-4000-8000-000000000008', 'mcq',
 'A relation is in first normal form, and every non-key attribute depends on the whole primary key rather than part of it. Which normal form does it now satisfy?',
 array['First normal form only', 'Second normal form', 'Third normal form', 'Boyce-Codd normal form'], '[1]'::jsonb,
 'Removing partial dependencies on part of a composite key is exactly what second normal form asks for. Third normal form additionally rules out transitive dependencies.',
 'medium', 2, true),

('c0000000-0000-4000-8000-000000000013', 'b0000000-0000-4000-8000-000000000008', 'mcq',
 'A relation has a non-trivial functional dependency whose determinant is not a superkey. Which normal form is definitely violated?',
 array['First normal form', 'Second normal form', 'Third normal form', 'Boyce-Codd normal form'], '[3]'::jsonb,
 'Boyce-Codd normal form requires the left side of every non-trivial dependency to be a superkey, so this violates it directly. The lower forms may still hold.',
 'hard', 2, true),

('c0000000-0000-4000-8000-000000000014', 'b0000000-0000-4000-8000-000000000008', 'msq',
 'Which problems does normalisation aim to reduce? Select all that apply.',
 array['Storing the same fact in many rows',
       'An update that leaves two copies of a fact disagreeing',
       'The number of joins a query needs',
       'A delete that removes a fact nobody intended to lose'],
 '[0, 1, 3]'::jsonb,
 'Normalisation targets redundancy and the insert, update and delete anomalies that follow from it. It usually increases the number of joins rather than reducing them, which is the trade-off.',
 'hard', 2, true),

-- ---- SQL Queries ----
('c0000000-0000-4000-8000-000000000015', 'b0000000-0000-4000-8000-000000000009', 'mcq',
 'Which clause filters rows after they have been grouped?',
 array['WHERE', 'HAVING', 'ORDER BY', 'GROUP BY'], '[1]'::jsonb,
 'WHERE runs before grouping and filters individual rows. HAVING runs afterwards and filters the groups, which is why aggregate conditions belong there.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000016', 'b0000000-0000-4000-8000-000000000009', 'msq',
 'Which of these can change how many rows come back from a query? Select all that apply.',
 array['A join', 'A WHERE condition', 'An ORDER BY clause', 'A GROUP BY clause'], '[0, 1, 3]'::jsonb,
 'A join can multiply rows, WHERE removes them, and GROUP BY collapses them. ORDER BY only rearranges the rows it is given.',
 'medium', 2, true),

('c0000000-0000-4000-8000-000000000017', 'b0000000-0000-4000-8000-000000000009', 'mcq',
 'A LEFT JOIN returns rows from the left table that have no match on the right. What appears in the right table''s columns for those rows?',
 array['Zero', 'An empty string', 'NULL', 'The row is skipped entirely'], '[2]'::jsonb,
 'There is no matching row to take values from, so the columns are filled with NULL, which means "no value" rather than zero or blank.',
 'easy', 1, true),

-- ---- Transactions & ACID ----
('c0000000-0000-4000-8000-000000000018', 'b0000000-0000-4000-8000-00000000000a', 'mcq',
 'Which ACID property promises that a committed transaction survives a power failure?',
 array['Atomicity', 'Consistency', 'Isolation', 'Durability'], '[3]'::jsonb,
 'Durability is the guarantee that once a commit is acknowledged, the change is on stable storage and will still be there after a crash.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000019', 'b0000000-0000-4000-8000-00000000000a', 'mcq',
 'Two transactions each hold a lock that the other is waiting for. What is this situation called?',
 array['Starvation', 'Deadlock', 'A dirty read', 'Thrashing'], '[1]'::jsonb,
 'Neither transaction can proceed because each is waiting on the other, and neither will release what it holds. The database has to detect this and abort one of them.',
 'medium', 1, true),

('c0000000-0000-4000-8000-00000000001a', 'b0000000-0000-4000-8000-00000000000a', 'mcq',
 'A transaction reads a row that another transaction has changed but not yet committed. What is this anomaly called?',
 array['A dirty read', 'A phantom read', 'A lost update', 'A non-repeatable read'], '[0]'::jsonb,
 'The data being read may never exist, because the writing transaction can still roll back. Reading uncommitted data is a dirty read.',
 'medium', 2, true),

-- ---- Indexing ----
('c0000000-0000-4000-8000-00000000001b', 'b0000000-0000-4000-8000-00000000000b', 'mcq',
 'Which index structure best supports queries asking for all values in a range?',
 array['Hash index', 'B-tree index', 'Bitmap index on a high-cardinality column', 'No index can help with ranges'], '[1]'::jsonb,
 'A B-tree keeps keys in sorted order, so once the start of the range is found the rest follows in sequence. A hash index scatters keys deliberately and cannot answer ranges.',
 'medium', 2, true),

('c0000000-0000-4000-8000-00000000001c', 'b0000000-0000-4000-8000-00000000000b', 'mcq',
 'Adding an index to a heavily written table generally makes which operation slower?',
 array['Reads that filter on the indexed column', 'Inserts and updates', 'Connecting to the database', 'Nothing becomes slower'], '[1]'::jsonb,
 'Every insert or update of the indexed column has to maintain the index as well as the table. Indexes buy read speed with write cost, which is why they are chosen rather than added everywhere.',
 'medium', 1, true),

-- ---- Percentages ----
('c0000000-0000-4000-8000-00000000001d', 'b0000000-0000-4000-8000-00000000000c', 'numeric',
 'A student scored 45 marks out of 60. What percentage is that?',
 null, '{"value": 75, "tol": 0.01}'::jsonb,
 '45 divided by 60 is 0.75, and multiplying by 100 gives 75 percent.',
 'easy', 1, true),

('c0000000-0000-4000-8000-00000000001e', 'b0000000-0000-4000-8000-00000000000c', 'mcq',
 'A price is increased by 20 percent and then the new price is reduced by 20 percent. Compared with the original, the final price is:',
 array['The same', '4 percent lower', '4 percent higher', '20 percent lower'], '[1]'::jsonb,
 'Take 100. Up 20 percent gives 120. Down 20 percent of 120 removes 24, leaving 96. The second percentage is taken on a larger amount, so the two do not cancel.',
 'medium', 2, true),

-- ---- Ratio & Proportion ----
('c0000000-0000-4000-8000-00000000001f', 'b0000000-0000-4000-8000-00000000000d', 'numeric',
 'An amount of 350 is divided between two people in the ratio 3:4. What does the person with the larger share receive?',
 null, '{"value": 200, "tol": 0}'::jsonb,
 'The ratio has 3 + 4 = 7 parts, so one part is 350 divided by 7, which is 50. The larger share is 4 parts, so 200.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000020', 'b0000000-0000-4000-8000-00000000000d', 'mcq',
 'If a is to b as 2 is to 3, and b is to c as 4 is to 5, what is a to c?',
 array['8 to 15', '2 to 5', '6 to 20', '3 to 4'], '[0]'::jsonb,
 'Scale the ratios so b matches: a to b is 8 to 12, and b to c is 12 to 15. That leaves a to c as 8 to 15.',
 'hard', 2, true),

-- ---- Probability ----
('c0000000-0000-4000-8000-000000000021', 'b0000000-0000-4000-8000-00000000000e', 'mcq',
 'A fair six-sided die is rolled once. What is the probability of getting a number greater than 4?',
 array['1 in 6', '1 in 3', '1 in 2', '2 in 3'], '[1]'::jsonb,
 'Only 5 and 6 are greater than 4, so 2 of the 6 equally likely faces succeed, which is 1 in 3.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000022', 'b0000000-0000-4000-8000-00000000000e', 'numeric',
 'Two fair coins are tossed together. What is the probability of getting exactly one head? Answer as a decimal.',
 null, '{"value": 0.5, "tol": 0.01}'::jsonb,
 'The four equally likely outcomes are HH, HT, TH and TT. Two of them have exactly one head, so the probability is 2 in 4, or 0.5.',
 'medium', 2, true),

('c0000000-0000-4000-8000-000000000023', 'b0000000-0000-4000-8000-00000000000e', 'mcq',
 'A fair coin has landed heads five times in a row. What is the probability that the next toss is heads?',
 array['Less than half, because tails is due', 'Exactly half', 'More than half, because heads is on a run', 'It cannot be determined'], '[1]'::jsonb,
 'The coin has no memory of previous tosses. Each toss is independent, so the probability stays at half. Believing otherwise is the gambler''s fallacy.',
 'medium', 2, true),

-- ---- Speed, Time & Distance ----
('c0000000-0000-4000-8000-000000000024', 'b0000000-0000-4000-8000-00000000000f', 'numeric',
 'A train covers 180 kilometres in 2.5 hours. What is its average speed in kilometres per hour?',
 null, '{"value": 72, "tol": 0.01}'::jsonb,
 'Average speed is total distance divided by total time: 180 divided by 2.5 gives 72.',
 'easy', 1, true),

('c0000000-0000-4000-8000-000000000025', 'b0000000-0000-4000-8000-00000000000f', 'mcq',
 'A journey is made at 40 km/h and the return along the same route at 60 km/h. What is the average speed for the whole trip?',
 array['50 km/h', '48 km/h', '52 km/h', '45 km/h'], '[1]'::jsonb,
 'Averaging the two speeds is the trap. More time is spent at the slower speed, so the correct figure is the harmonic mean: two times 40 times 60, divided by 100, which is 48.',
 'hard', 2, true)

on conflict do nothing;

commit;

-- ---------------------------------------------------------------------------
-- What went in
-- ---------------------------------------------------------------------------
select
    (select count(*) from public.topics where parent_id is null)     as subjects,
    (select count(*) from public.topics where parent_id is not null) as topics,
    (select count(*) from public.questions where is_verified)        as verified_questions;
