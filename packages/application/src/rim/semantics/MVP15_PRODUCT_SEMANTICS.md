PRODUCT SEMANTICS

1. Ban
Ban — временное социальное действие от одного пользователя к другому, в котором один человек запрещает другому одно конкретное поведение.
SENDER — пользователь, который отправил Ban.
RECEIVER — пользователь, который получил Ban.
У Ban есть banText и duration.
duration выбирает SENDER: целое число от 3 до 60 минут.
Duration начинает отсчитываться только после принятия Ban RECEIVER.

2. Ban lifecycle
AWAITING_RESPONSE — Ban отправлен, но RECEIVER ещё не принял его и не выбрал OVERBOARD.
ACTIVE — RECEIVER принял Ban, duration запущен и ещё не закончился.
CHECK_PENDING — duration закончился, Check начался, но ещё нет обоих ответов.
CHECK_COMPLETED — оба пользователя ответили на Check, и Ban получил финальный Status.
OVERBOARD — RECEIVER посчитал Ban перебором. Ban завершается без запуска duration и без Check.

3. Check
Check — проверка после завершения duration, в которой SENDER и RECEIVER независимо отвечают, был ли Ban выполнен.
У каждого пользователя один из двух ответов:
FULFILLED — пользователь считает, что Ban был выполнен.
NOT_FULFILLED — пользователь считает, что Ban не был выполнен.
Ответ одного пользователя не определяет ответ другого.

4. Status
Status — финальный результат Ban после того, как SENDER и RECEIVER ответили на Check.
BANTASTIC — оба считают, что Ban выполнен.
BANFLICT — пользователи расходятся в оценке выполнения Ban. Важно сохранять, кто именно дал какой ответ.
FAIR_ENOUGH — оба считают, что Ban не выполнен.
OVERBOARD не является результатом Check: он возникает раньше и завершает Ban без Check.

5. USER, CONTACT и Relationship
USER — текущий пользователь, который разговаривает с RIM.
CONTACT — другой пользователь 98+, которого USER выбрал для разговора с RIM.
Relationship — отношения между конкретными USER и CONTACT. История Bans между ними рассматривается как история именно этой пары.
RIM анализирует отношения только этой пары: USER ↔ CONTACT.
Направление каждого Ban определяется относительно этой пары:
USER_TO_CONTACT — USER был SENDER, CONTACT был RECEIVER.
CONTACT_TO_USER — CONTACT был SENDER, USER был RECEIVER.
То есть USER и CONTACT — не постоянные роли человека в продукте. Это роли относительно текущего RIM Chat. Если другой человек откроет RIM Chat и выберет первого, перспектива поменяется местами.


| SENDER | RECEIVER | Status |
| --- | --- | --- |
| FULFILLED | FULFILLED | BANTASTIC |
| FULFILLED | NOT_FULFILLED | BANFLICT |
| NOT_FULFILLED | FULFILLED | BANFLICT |
| NOT_FULFILLED | NOT_FULFILLED | FAIR_ENOUGH |
